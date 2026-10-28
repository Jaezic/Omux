// Reconcile tmux into Orca: each tmux session becomes an Orca project group, each tmux window a
// folder workspace in it (named after the window, pointing at the window's current folder, so
// Orca's explorer/diff show that folder) holding one tab attached to the window. Remote hosts use
// the orcad server Orca runs on them, so their workspaces live remotely like Orca's own.
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { attachCommand, unitViewName } from './attach-command.mjs'
import { createRelay } from './relay.mjs'
import { resolveHosts } from './hosts.mjs'
import { controlPath, findOrcaAgentArgs, resumeArgs, scanHost } from './scan.mjs'

// ORCA_TMUX_HOME redirects all state (tests use a temp dir).
const ROOT = process.env.ORCA_TMUX_HOME || join(homedir(), '.orca-tmux')
const LOGIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'login.sh')
const TOOL_ROOT = dirname(dirname(fileURLToPath(import.meta.url))) // never a nested card of its own
const STATE_FILE = join(ROOT, 'state.json')
const DEFAULT_CONFIG = {
  // 'orca': local + SSH hosts currently connected in Orca; 'ssh-config': every Host alias; or a list.
  hosts: 'orca',
  exclude: [],
  // Seconds between light checks; a full sync runs only when tmux or Orca changed (or every 30s).
  // tmux hooks wake the runner at once when windows, panes or sessions come and go.
  intervalSec: 3,
  // A workspace added in Orca named "claude …" / "codex …" opens a window running this command.
  agentCommands: { claude: 'claude', codex: 'codex' },
  // Changed git repos inside a non-git window's folder get a card in this status lane (matched by
  // label or id); no lane, no cards. false turns it off.
  nestedRepoLane: '저장소',
  notify: true,
  // Workspace status (Orca's status lanes) follows the window's agents; false turns it off.
  // Keys: waiting, working, idle, none -> Orca workspace status ids.
  // later: idle longer than laterAfterMin minutes (things that can wait).
  autoStatus: { waiting: 'in-review', working: 'in-progress', idle: 'completed', later: 'todo', none: 'todo' },
  laterAfterMin: 60,
  // "Manual" sort = agent activity: waiting, working, then most recently finished first.
  activityOrder: true,
  closeTabKillsWindow: true
}
// A closed tab lingers in Orca's listings for ~2s: decide only after this long.
const SETTLE_MS = 4000
// A "+" tab closes this long after its window opened: long enough for an agent picked in the "+"
// menu to have started, so it can be carried over to the window.
const PLUS_SETTLE_MS = 1500
// A window that cd'd into or out of a git repo moves to that card once it stayed this long.
const CARD_MOVE_MS = 60_000
const GLYPH = { working: '⠿', idle: '✳', waiting: '✋' }

// Read dozens of times per pass: parsed again only when the file changed.
let configCache = { stamp: null, config: null }
export function loadConfig() {
  const path = join(ROOT, 'config.json')
  let stamp = 'none'
  try {
    const st = statSync(path)
    stamp = `${st.mtimeMs}:${st.size}`
  } catch {}
  if (configCache.stamp !== stamp) {
    let config
    try {
      config = { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(path, 'utf8')) }
    } catch {
      config = { ...DEFAULT_CONFIG }
    }
    configCache = { stamp, config }
  }
  return { ...configCache.config }
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref())

function sh(cmd, args, env) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env, timeout: 15_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })
}

// groups: `${host}/${session}` -> project group id
// windows: `${host}/${windowId}` -> { fw, group, name, folder, tabs, autoStatus, order }
// panes: `${host}/${paneId}` -> { state, since } for agent panes (how long they have been idle)
// repos: `${host}/${repoId}` git project cards this tool registered (the only ones it may remove)
// cards: `${host}/${cardKey}` -> { autoStatus, manualStatus, order } lane/order bookkeeping per card
// nested: `${host}/${repoId}` -> { path, cleanSince } git cards added for changed repos found inside
//   a non-git window's folder (kept in their own status lane, no tabs)
// sessionIds: `${host}/${session}` -> tmux session id ($N), to follow renames
// removedWindows: window keys whose card the user removed but that were kept (busy agent, or several at once)
// relay: host -> { group, fw } the hidden workspace the relay reaches the host's files through
function loadState() {
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    return {
      groups: state.groups ?? {},
      windows: state.windows ?? {},
      panes: state.panes ?? {},
      repos: state.repos ?? [],
      cards: state.cards ?? {},
      nested: state.nested ?? {},
      relay: state.relay ?? {},
      sessionIds: state.sessionIds ?? {},
      removedWindows: state.removedWindows ?? []
    }
  } catch {
    return { groups: {}, windows: {}, panes: {}, repos: [], cards: {}, nested: {}, relay: {}, sessionIds: {} }
  }
}

let savedState = null
function saveState(state) {
  try {
    const text = JSON.stringify(state, null, 2)
    if (text === savedState) {
      return // unchanged: most passes
    }
    mkdirSync(ROOT, { recursive: true })
    writeFileSync(STATE_FILE, text)
    savedState = text
  } catch {
    // best effort: a lost state file only means workspaces get recreated
  }
}

// The title Orca sees through tmux set-titles. Orca reads a braille spinner as working,
// "✳ " as idle (claude) and "<agent> - action required" as waiting for permission.
// Orca stamps title-detected agents "now", so the idle time is carried in the title instead.
export function idleAge(pane, now = Date.now()) {
  return pane.state === 'idle' ? stateAge(pane, now) : ''
}

// How long the agent has been in its current state (idle, working or waiting), for tab labels:
// Orca's status icon in front of the tab tells which.
export function stateAge(pane, now = Date.now()) {
  if (!pane.since) {
    return ''
  }
  const minutes = Math.floor((now - pane.since) / 60_000)
  if (minutes < 1) {
    return ''
  }
  if (minutes < 60) {
    return `${minutes < 5 ? minutes : Math.floor(minutes / 5) * 5}m`
  }
  return minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`
}

// What the agent says it is working on, from the title it sets: claude "✳ <task>", codex
// "<task> | <folder>". Empty for defaults ("Claude Code", tmux's host name).
export function agentTask(pane) {
  let task = (pane.title ?? '').replace(/^[⠀-⣿✳✻✶✢·*]\s*/u, '').trim()
  if (pane.agent === 'codex') {
    task = task.replace(/\s+\|\s+[^|]*$/, '').trim()
  }
  if (!task || task === pane.hostShort || /^(claude code|claude|codex)$/i.test(task)) {
    return ''
  }
  return task.length > 48 ? `${task.slice(0, 47)}…` : task
}

// A window's name in Orca: the name it was given, or for one tmux names after its command (claude
// shows as its version, "2.1.311") the task of its agent (the active one first).
export function windowLabel(window) {
  if (!window.autoName) {
    return window.name
  }
  const agents = window.panes.filter((p) => p.agent).sort((a, b) => Number(b.active) - Number(a.active))
  const task = agents.map(agentTask).find(Boolean)
  if (task) {
    return task
  }
  return agents.length && /^\d+\.\d+(\.\d+)?$/.test(window.name) ? agents[0].agent : window.name
}

export const cardName = (window, mark = '') => [mark, window.index, windowLabel(window)].filter((x) => x !== '').join(' ')

export function orcaTitle(pane) {
  const task = [agentTask(pane), idleAge(pane)].filter(Boolean).join(' · ')
  if (pane.state === 'waiting') {
    return `${pane.agent} - action required · ${pane.ask ? `${pane.ask} · ` : ''}${task}`
  }
  if (pane.state === 'working') {
    return `⠋ ${pane.agent} · ${task}`
  }
  return pane.agent === 'claude' ? `✳ claude · ${task}` : `${pane.agent} · ${task}`
}

// Orca's in-band agent status (OSC 9999), the same record its own agent hooks produce. It is what
// Orca's send-to-agent picker, permission alerts, activity feed and dashboard read; titles alone
// only reach the sidebar rows.
// The task (from the agent's title) rides along as the prompt; on "done" the agent's last answer
// read off its screen (or the task) is the last message, the body of Orca's completion notification.
export function agentStatusPayload(pane, now = Date.now()) {
  const since = pane.since ?? now
  const task = agentTask(pane)
  const base = { agentType: pane.agent, stateStartedAt: since, ...(task ? { prompt: task } : {}) }
  if (pane.state === 'working') {
    return { state: 'working', ...base }
  }
  if (pane.state === 'waiting') {
    const command = pane.ask && !/^(Do you want|Would you like)/.test(pane.ask)
    return { state: 'waiting', ...base, ...(command ? { toolName: 'Bash' } : {}), ...(pane.ask ? { toolInput: pane.ask } : {}) }
  }
  const message = pane.message || task
  return { state: 'done', ...base, turnCompletedAt: since, ...(message ? { lastAssistantMessage: message } : {}) }
}

export function windowTitle(window) {
  const agents = window.panes.filter((p) => p.agent)
  const summary = agents.map((p) => `${GLYPH[p.state] ?? ''}${p.agent}`).join(' ')
  return [cardName(window), summary].filter(Boolean).join(' · ')
}

// What a reconcile depends on, so an unchanged host can be skipped between full passes. Terminal
// titles are left out (Orca's own terminals retitle constantly); agent pane titles are in.
export function hostFingerprint(scan, groups, folderWorkspaces, terminals) {
  return JSON.stringify([
    scan.sessions.map((s) => [
      s.name,
      s.windows.map((w) => [w.id, w.index, w.name, w.path, w.gitRoot, w.panes.map((p) => [p.id, p.agent, p.state, p.agent ? p.title : '', p.ask, p.doneAt, p.message])])
    ]),
    [...scan.views].map(([name, v]) => [name, v.attached, v.tty]),
    groups.map((g) => [g.id, g.name, g.parentPath]),
    folderWorkspaces.map((w) => [w.id, w.name, w.projectGroupId, w.folderPath]),
    (terminals ?? []).map((t) => [t.handle, t.worktreeId])
  ])
}

// tmux hooks that touch `trigger` whenever sessions, windows or panes come and go, so changes
// show up at once instead of at the next pass. A fixed array index keeps them idempotent and
// leaves the user's own hooks alone.
const HOOKS = ['after-new-window', 'after-split-window', 'after-kill-pane', 'pane-exited', 'window-linked', 'window-unlinked', 'window-renamed', 'session-created', 'session-closed', 'session-renamed']
export function hookScript(trigger) {
  return [
    'PATH=$PATH:/opt/homebrew/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin',
    ...HOOKS.map((h) => `tmux set-hook -g '${h}[77]' "run-shell -b 'touch ${trigger}'" 2>/dev/null`),
    'true'
  ].join('; ')
}

// Cards of SSH hosts start with a colored dot, one color per host, so hosts tell apart in a status
// lane (Orca refuses tab colors from outside while its window owns the layout). Local cards stay
// plain. config.hostColors overrides ({ "<host>": "🟢" }, "" for none); hostMarks: false turns it off.
const HOST_MARKS = ['🔵', '🟣', '🔴', '🟠', '🟡', '🟢', '🟤']
export function hostMark(host, config = {}) {
  if (config.hostMarks === false) {
    return ''
  }
  if (config.hostColors && host in config.hostColors) {
    return config.hostColors[host] ?? ''
  }
  if (host === 'local') {
    return ''
  }
  let hash = 0
  for (const ch of host) {
    hash = (hash * 31 + ch.codePointAt(0)) >>> 0
  }
  return HOST_MARKS[hash % HOST_MARKS.length]
}

// A Linear issue key in a branch name ("mgjeong/sva-1593-fix", "SVA-1593"), upper-cased.
export function branchIssue(branch = '') {
  const m = branch.match(/(?:^|[/_-])([a-z][a-z0-9]{1,9})-(\d{1,6})(?=$|[/_.-])/i)
  return m ? `${m[1].toUpperCase()}-${m[2]}` : null
}

// scan/runTmux are injectable so tests never touch a real tmux server.
export function createSyncEngine({
  cli,
  bridge,
  env,
  log = () => {},
  notify = async () => {},
  scan = scanHost,
  runTmux = null
}) {
  const state = loadState()
  const everAttached = new Set() // windows whose view we saw attached in this run
  const dismissed = new Set() // windows whose tab the user closed (kept, not reopened)
  // Windows whose card the user removed but that were kept; remembered across restarts so the card
  // does not come back, until the window itself closes.
  const removedWindows = new Set(state.removedWindows ?? [])
  const pending = new Map() // window key -> when its tab was created
  const failures = new Map() // window key -> { count, retryAt }
  const suspects = new Map() // window key -> when its view was first seen missing
  const createdThisTick = new Set() // windows created this tick (absent from the scan, not gone)
  const hostBackoff = new Map() // host -> { failures, retryAt }
  const agentStates = new Map() // `${host}/${paneId}` -> state, for completion notifications
  const paneTitles = new Map() // `${host}/${paneId}` -> last @orca_title written
  const seenWorkspaces = new Set() // folder workspaces confirmed to exist in this run
  const plusTabs = new Map() // "+" tab handle -> { windowId, at }: its window is open, the tab closes once settled
  const cardMoves = new Map() // window key -> { root, at }: cd'd into/out of a repo, card move pending
  const lastFull = new Map() // host -> { fingerprint, at } of the last full reconcile
  const followUp = new Set() // hosts with something in flight (new tab settling, tab just created)
  const hooksSetAt = new Map() // host -> when the tmux hooks were last (re)installed
  let linearCheck = { at: 0, connected: false }
  const linearIssues = new Map() // identifier -> exists (checked once)
  const statusSent = new Map() // paneKey -> last OSC 9999 status written to its tab { json, tty, at }
  const cardCreatedAt = new Map() // cardKey -> when this run created the card
  const agentLaunchedAt = new Map() // cardKey -> when its agent was started in tmux instead of Orca
  const baselined = new Set() // cardKeys whose pre-existing terminals were noted
  const seenRepos = new Set() // git project cards confirmed to exist in this run
  const repoUnusedSince = new Map() // own repo card -> when it last had no window
  const nestedScans = new Map() // host -> { at, changed: [{ folder, path }] }
  const nestedDismissed = new Set() // `${host}/${path}` nested cards the user removed
  let laneCache = { at: 0, lanes: [] }
  const closedByUs = new Set() // handles we closed; they linger in listings briefly
  const adoptFailed = new Set() // user-created workspaces we could not turn into windows
  const createdWorkspaces = new Set() // workspaces this run created (never adopted as user-made)
  const createdGroups = new Set() // groups this run created (never adopted as user-made)
  const attention = new Set() // windows with a real completion/approval since last read
  const loginTabs = new Map() // host -> { handle } while the password prompt is open
  const loginCooldown = new Map() // host -> no login prompt before this time
  const warned = new Set()
  let environments = new Map() // host -> orcad environment id
  let loginWorkspace = null // local workspace that hosts login tabs
  const lanes = new Map() // SSH host -> its pass in progress (they run beside the local one)
  let orcaFacts = { at: 0, runtimeId: null, orcaHosts: [] }

  // A host without its environment (listing failed, host just went away) fails the call: with no
  // environment the bridge would ask the local runtime, and a remote id would land on local Orca.
  const rpc = (host, method, params) => {
    if (host === 'local') {
      return bridge.call(null, method, params)
    }
    const environment = environments.get(host)
    return environment ? bridge.call(environment, method, params) : Promise.reject(new Error(`${host}: not connected in Orca`))
  }
  const relay = createRelay({ rpc, state, log, intervalSec: () => loadConfig().intervalSec ?? 5 })
  // SSH hosts connected in Orca are reached over Orca's own connection (lib/relay.mjs), not ssh.
  const viaOrca = (host) => host !== 'local' && environments.has(host) && loadConfig().viaOrca !== false

  function remoteTmux(host, script) {
    if (runTmux) {
      return runTmux(host, script)
    }
    if (viaOrca(host)) {
      return relay.exec(host, script)
    }
    return host === 'local'
      ? sh('/bin/sh', ['-c', script], env)
      : sh('ssh', ['-o', 'BatchMode=yes', '-o', 'ControlMaster=auto', '-o', `ControlPath=${controlPath()}`, '-o', 'ControlPersist=180', host, script], env)
  }

  async function closeOwnTerminal(host, handle) {
    closedByUs.add(handle)
    if (closedByUs.size > 500) {
      closedByUs.delete(closedByUs.values().next().value)
    }
    // closeTab handles visible tabs; close handles PTYs whose tab is already gone.
    await rpc(host, 'terminal.closeTab', { terminal: handle }).catch(() =>
      rpc(host, 'terminal.close', { terminal: handle }).catch(() => {})
    )
  }

  // A window's card is its git repo (an Orca git project: diff, source control, branches) when its
  // folder is inside one, like VS Code; otherwise a folder workspace of its own.
  // cardKey matches Orca's terminal worktreeId; cardSelector addresses the card in RPCs.
  const cardKey = (rec) => (rec.repo ? `${rec.repo}::${rec.root}` : `folder:${rec.fw}`)
  const cardSelector = (rec) => (rec.repo ? `id:${rec.repo}::${rec.root}` : `folder:${rec.fw}`)
  const ownedHandles = (host, key) =>
    new Set(
      Object.entries(state.windows)
        .filter(([k, r]) => k.startsWith(`${host}/`) && cardKey(r) === key)
        .flatMap(([, r]) => Object.values(r.tabs ?? {}).map((t) => t.handle))
    )

  // A window leaves its card: its tabs close, and its folder card goes.
  async function retireCard(host, rec) {
    for (const [unitKey, tab] of Object.entries(rec.tabs ?? {})) {
      await closeOwnTerminal(host, tab.handle)
      forgetUnit(unitKey)
    }
    if (rec.fw) {
      await rpc(host, 'folderWorkspace.delete', { folderWorkspaceId: rec.fw }).catch(() => {})
    }
  }

  // at: the number to open it at (taken meanwhile: tmux picks one, as without it).
  async function openTmuxWindow(host, session, cwd, at = null) {
    const dir = cwd ? ` -c ${shq(cwd)}` : ''
    const open = (target) =>
      remoteTmux(host, `PATH=$PATH:/opt/homebrew/bin:/usr/local/bin; tmux new-window -d -P -F '#{window_id} #{window_index} #{window_name}'${dir} -t ${shq(`=${session}:${target}`)}`)
    const out = (await (at === null ? open('') : open(at).catch(() => open('')))).trim()
    const [, id, index, name] = out.match(/^(@\d+)(?: (\d+) (.*))?$/) ?? []
    if (!id) {
      throw new Error(`unexpected window id ${JSON.stringify(out)}`)
    }
    return { id, index: Number(index ?? 0), name: name ?? '' }
  }

  const newTmuxWindow = async (host, session, cwd) => (await openTmuxWindow(host, session, cwd)).id

  // A window opened from Orca gets its card and tab in the same pass (not on the next scan), and
  // the tab gets focus. rec is the card it was opened from: the same git card, or a new folder card.
  // fwCreated: the folder card, already being created while the window was opened (its name, which
  // needs the window's number, follows).
  async function openWindowCard(host, session, rec, win, fwCreated) {
    const key = `${host}/${win.id}`
    const window = { id: win.id, index: win.index, name: win.name, autoName: true, panes: [] }
    const name = cardName(window, hostMark(host, loadConfig()))
    let card = { repo: rec.repo, root: rec.root }
    if (!rec.repo) {
      const { folderWorkspace } = await fwCreated
      card = { fw: folderWorkspace.id }
      if (folderWorkspace.name !== name) {
        later(host, rpc(host, 'folderWorkspace.update', { folderWorkspaceId: folderWorkspace.id, updates: { name } }).catch(() => {}))
      }
    }
    const next = { ...card, group: rec.group, name, folder: rec.folder, tabs: {} }
    const title = windowTitle(window)
    const { terminal } = await rpc(host, 'terminal.create', { worktree: cardSelector(next), title, command: attachCommand(session, win.id, null) })
    next.tabs[key] = { handle: terminal.handle, title }
    state.windows[key] = next
    pending.set(key, Date.now())
    createdThisTick.add(key)
    rpc(host, 'terminal.focus', { terminal: terminal.handle, navigation: 'host' }).catch(() => {}) // not waited for
  }

  // Starts an agent in a window's shell (the window outlives the agent), optionally naming the window.
  async function startAgent(host, windowId, kind, title = '', extraArgs = '') {
    const command = [loadConfig().agentCommands?.[kind] ?? kind, extraArgs].filter(Boolean).join(' ')
    const rename = title ? ` \\; rename-window -t ${shq(windowId)} ${shq(title)}` : ''
    await remoteTmux(host, `tmux send-keys -t ${shq(windowId)} -l ${shq(command)} \\; send-keys -t ${shq(windowId)} Enter${rename}`).catch(
      (err) => log(`starting ${kind} failed: ${err.message}`)
    )
  }

  // Which agent the tab bar's "+" started in an Orca tab, if any: Orca knows that one runs but not
  // which, so the banner on screen tells claude from codex.
  async function tabAgent(host, handle) {
    const { isRunningAgent } = await rpc(host, 'terminal.isRunningAgent', { terminal: handle }).catch(() => ({}))
    if (!isRunningAgent) {
      return null
    }
    const { terminal } = await rpc(host, 'terminal.read', { terminal: handle }).catch(() => ({}))
    const screen = (terminal?.tail ?? []).join('\n')
    return /claude code/i.test(screen) ? 'claude' : /codex/i.test(screen) ? 'codex' : null
  }

  // Orca calls of a pass that nothing later in the pass waits on (tab titles, card names): sent
  // together and awaited once at the end. Each call to an SSH host's runtime costs ~0.35 s.
  const passTasks = new Map()
  const emptyScans = new Set() // hosts whose last scan had no windows // host -> promises
  const later = (host, promise) => passTasks.get(host)?.push(promise) ?? promise

  async function reconcileHost(scan, runtimeId) {
    const { host } = scan
    // No windows at all while windows are mirrored: tmux may just have hiccuped (its errors are
    // silenced in the scan). Taken as real only when the next scan agrees, since acting on it
    // removes every card, tab and group of the host.
    if (!scan.sessions.some((s) => s.windows.length) && Object.keys(state.windows).some((k) => k.startsWith(`${host}/`)) && !emptyScans.has(host)) {
      emptyScans.add(host)
      return
    }
    emptyScans.delete(host)
    passTasks.set(host, [])
    // For an SSH host the projects and worktrees are asked for alongside the first lists (one round
    // trip instead of two); locally they are only fetched when the pass is not skipped.
    const listProjects = () => Promise.all([rpc(host, 'repo.list', {}), rpc(host, 'worktree.list', { limit: 1000 })])
    const projects = host === 'local' ? null : listProjects()
    projects?.catch(() => {})
    const [{ groups }, { folderWorkspaces }, { terminals }] = await Promise.all([
      rpc(host, 'projectGroup.list', null),
      rpc(host, 'folderWorkspace.list', {}),
      rpc(host, 'terminal.list', { limit: 1000 })
    ])
    // Nothing changed in tmux or Orca since the last full pass: skip it (one every 30s regardless,
    // for idle ages and anything not in the fingerprint).
    // A "+" tab closed before it settled is never seen again by adoptPlusTabs: forget it here, or it
    // would keep asking for a follow-up pass every second.
    if (terminals) {
      const open = new Set(terminals.map((t) => t.handle))
      for (const [handle, plus] of plusTabs) {
        if (plus.host === host && !open.has(handle)) {
          plusTabs.delete(handle)
        }
      }
    }
    const fingerprint = hostFingerprint(scan, groups, folderWorkspaces, terminals)
    const last = lastFull.get(host)
    if (last && last.fingerprint === fingerprint && !followUp.has(host) && Date.now() - last.at < 30_000) {
      return
    }
    lastFull.set(host, { fingerprint, at: Date.now() })
    if (!runTmux && Date.now() - (hooksSetAt.get(host) ?? 0) > 600_000) {
      hooksSetAt.set(host, Date.now())
      const trigger = host === 'local' ? join(ROOT, 'trigger') : '$HOME/.orca-tmux/remote/trigger'
      later(host, remoteTmux(host, hookScript(trigger)).catch((err) => log(`tmux hooks on ${host} failed: ${err.message}`)))
    }
    const [{ repos: repoList }, { worktrees: worktreeList }] = await (projects ?? listProjects())
    const repos = new Map(repoList.map((r) => [r.id, r]))
    const reposByPath = new Map(repoList.map((r) => [r.path, r]))
    const worktrees = new Map((worktreeList ?? []).map((w) => [w.id, w]))
    const ownGroups = new Set(Object.values(state.groups))
    const cardsSeen = new Map() // cardKey -> { rec, windows: [{ key, window }] }
    const groupIds = new Set(groups.map((g) => g.id))
    const workspaces = new Map(folderWorkspaces.map((fw) => [fw.id, fw]))
    const terminalsByWorkspace = new Map()
    for (const t of terminals ?? []) {
      if (!terminalsByWorkspace.has(t.worktreeId)) {
        terminalsByWorkspace.set(t.worktreeId, new Set())
      }
      terminalsByWorkspace.get(t.worktreeId).add(t.handle)
    }
    // A group the user just added in Orca as "<host> · <name>" becomes a new tmux session. Older
    // untracked groups named like ours are leftovers from an earlier run (lost state file, groups
    // from before parentPath was set): removed with their workspaces.
    const tracked = new Set(Object.values(state.groups))
    const adoptedGroups = new Set()
    for (const g of groups.filter((g) => g.name.startsWith(`${host} · `) && !tracked.has(g.id))) {
      const fresh = Date.now() - (g.createdAt ?? 0) < 120_000
      if (fresh && !createdGroups.has(g.id)) {
        const name = g.name.slice(`${host} · `.length).trim().replace(/[.:]/g, '_') // tmux forbids . and :
        if (name) {
          if (!scan.sessions.some((s) => s.name === name)) {
            const cwd = g.parentPath || scan.home || homedir()
            await remoteTmux(host, `PATH=$PATH:/opt/homebrew/bin:/usr/local/bin; tmux new-session -d -s ${shq(name)} -c ${shq(cwd)}`).then(
              () => log(`new group became tmux session ${host}/${name}`),
              (err) => log(`could not create session ${name}: ${err.message}`)
            )
          }
          if (g.name !== `${host} · ${name}`) {
            await rpc(host, 'projectGroup.update', { groupId: g.id, updates: { name: `${host} · ${name}` } }).catch(() => {})
          }
          state.groups[`${host}/${name}`] = g.id
          adoptedGroups.add(`${host}/${name}`)
          continue
        }
      }
      for (const fw of folderWorkspaces.filter((f) => f.projectGroupId === g.id)) {
        for (const handle of terminalsByWorkspace.get(`folder:${fw.id}`) ?? []) {
          await closeOwnTerminal(host, handle)
        }
        await rpc(host, 'folderWorkspace.delete', { folderWorkspaceId: fw.id }).catch(() => {})
        workspaces.delete(fw.id)
      }
      await rpc(host, 'projectGroup.delete', { groupId: g.id }).catch(() => {})
      groupIds.delete(g.id)
      log(`removed leftover group ${g.name}`)
    }
    const liveWindows = new Set()
    const liveViews = new Set()
    const vanished = [] // { window, paneId, session }: tabs/workspaces the user removed
    const aliveSessions = new Set()

    await syncSessionNames(host, scan, groups)

    for (const session of scan.sessions) {
      // 1. Session -> project group.
      const groupKey = `${host}/${session.name}`
      if (!groupIds.has(state.groups[groupKey])) {
        // The sidebar only renders folder workspaces whose group has a parentPath.
        const { group } = await rpc(host, 'projectGroup.create', {
          name: `${host} · ${session.name}`,
          parentPath: scan.home || homedir()
        })
        createdGroups.add(group.id)
        state.groups[groupKey] = group.id
        groupIds.add(group.id)
      }
      const groupId = state.groups[groupKey]

      for (const window of session.windows) {
        const key = `${host}/${window.id}`
        liveWindows.add(key)
        trackAgentStates(host, session.name, window)
        let rec = state.windows[key]
        if (removedWindows.has(key)) {
          continue // its workspace was removed but the window kept: don't bring the workspace back
        }

        // 2. Window -> its card (git project or folder workspace).
        const gone = rec && (rec.repo ? !repos.has(rec.repo) && seenRepos.has(rec.repo) : rec.fw && !workspaces.has(rec.fw) && seenWorkspaces.has(rec.fw))
        if (gone) {
          // The user removed this window's card in Orca: like closing its tab, it kills the window
          // (subject to the same one-at-a-time rule below).
          if (runtimeId && Object.values(rec.tabs ?? {}).some((t) => t.runtimeId === runtimeId)) {
            vanished.push({ window, paneId: null, session: session.name, windowKey: key, cardRemoved: true })
            delete state.windows[key]
            continue
          }
        }
        // Renamed in Orca (the workspace name is not what this tool last set, the window's is): the
        // tmux window takes the new name, without the index prefix.
        const mark = hostMark(host, loadConfig())
        const renamed = rec?.fw && !rec.repo && workspaces.get(rec.fw)?.name
        if (renamed && renamed !== rec.name && rec.name === cardName(window, mark)) {
          // Without the host's dot and the index prefix.
          const title = renamed.replace(/^\p{Extended_Pictographic}\s*/u, '').replace(new RegExp(`^${window.index}\\s+`), '').trim()
          if (title && title !== window.name) {
            await remoteTmux(host, `tmux rename-window -t ${shq(window.id)} ${shq(title)}`).then(
              () => {
                log(`workspace renamed; tmux window ${host} ${session.name}:${window.index} is now ${title}`)
                window.name = title
                window.autoName = false // rename-window turns tmux's automatic naming off
              },
              (err) => log(`rename-window failed: ${err.message}`)
            )
          }
        }
        const name = cardName(window, mark)
        let folder = window.path || homedir()
        let root = loadConfig().gitCards !== false ? window.gitRoot : null
        // Moving a window to another card closes its tab and opens one there, so it waits until the
        // window has stayed in a repo (or out of one) for a minute: a quick cd in and out while
        // typing must not pull the tab away.
        const moving = rec && (root ? rec.root !== root : !rec.fw)
        if (moving) {
          const since = cardMoves.get(key)
          if (!since || since.root !== root) {
            cardMoves.set(key, { root, at: Date.now() })
          }
        } else {
          cardMoves.delete(key)
        }
        const settled = moving && Date.now() - cardMoves.get(key).at >= CARD_MOVE_MS
        if (moving && !settled) {
          root = rec.repo ? rec.root : null // stay on the current card for now
          if (rec.repo) {
            folder = rec.folder
          }
        }
        if (moving && settled) {
          cardMoves.delete(key)
          await retireCard(host, rec)
          everAttached.delete(key)
          rec = undefined
        }
        if (root) {
          let repo = reposByPath.get(root)
          if (!repo) {
            ;({ repo } = await rpc(host, 'repo.add', { path: root, kind: 'git', displayName: basename(root) }))
            state.repos.push(`${host}/${repo.id}`)
            repos.set(repo.id, repo)
            reposByPath.set(root, repo)
            cardCreatedAt.set(`${repo.id}::${root}`, Date.now())
          }
          // A repo card lives in one group: the first session using it keeps it.
          if (repo.projectGroupId !== groupId && !ownGroups.has(repo.projectGroupId)) {
            await rpc(host, 'projectGroup.moveProject', { repo: `id:${repo.id}`, groupId }).then(
              () => (repo.projectGroupId = groupId),
              (err) => log(`moving ${root} into ${session.name} failed: ${err.message}`)
            )
          }
          rec = { ...(rec ?? {}), repo: repo.id, root, group: groupId, name, folder }
          delete rec.fw
          state.windows[key] = rec
          seenRepos.add(repo.id)
        } else if (!rec?.fw || !workspaces.has(rec.fw) || rec.group !== groupId) {
          if (rec?.fw && workspaces.has(rec.fw)) {
            await rpc(host, 'folderWorkspace.delete', { folderWorkspaceId: rec.fw }).catch(() => {})
          }
          const { folderWorkspace } = await rpc(host, 'folderWorkspace.create', {
            projectGroupId: groupId,
            name,
            folderPath: folder
          })
          createdWorkspaces.add(folderWorkspace.id)
          rec = { fw: folderWorkspace.id, group: groupId, name, folder, tabs: rec?.tabs }
          state.windows[key] = rec
          workspaces.set(rec.fw, folderWorkspace)
          cardCreatedAt.set(`folder:${rec.fw}`, Date.now())
          everAttached.delete(key)
        } else if (rec.name !== name || rec.folder !== folder) {
          // Renamed in tmux, or cd'd elsewhere: the workspace follows; the tab stays.
          later(
            host,
            rpc(host, 'folderWorkspace.update', {
              folderWorkspaceId: rec.fw,
              updates: { name, folderPath: folder }
            }).catch((err) => log(`update workspace ${name} failed: ${err.message}`))
          )
        }
        if (rec.fw) {
          seenWorkspaces.add(rec.fw)
        }
        rec.name = name
        rec.folder = folder
        const card = cardKey(rec)
        if (!cardsSeen.has(card)) {
          cardsSeen.set(card, { rec, windows: [], meta: rec.repo ? worktrees.get(card) : workspaces.get(rec.fw) })
        }
        cardsSeen.get(card).windows.push({ key, window })
        const handles = terminalsByWorkspace.get(card) ?? new Set()

        // 3. Tabs: one per agent pane (each reports only its pane's status), or one for the
        // whole window when it runs no agent.
        if (rec.handle) {
          // State from before per-pane tabs.
          rec.tabs = { [key]: { handle: rec.handle, title: rec.title, runtimeId: rec.runtimeId } }
          delete rec.handle
          delete rec.title
          delete rec.runtimeId
        }
        rec.tabs ??= {}
        const units = tabUnits(host, window)
        for (const unitKey of Object.keys(rec.tabs)) {
          if (!units.some((u) => u.key === unitKey)) {
            // Agent exited (or started) so the window's tab layout changed: retire, never kill.
            await closeOwnTerminal(host, rec.tabs[unitKey].handle)
            delete rec.tabs[unitKey]
            forgetUnit(unitKey)
          }
        }
        await adoptPlusTabs(host, session.name, rec, handles, session.windows)
        for (const unit of units) {
          liveViews.add(unit.view)
          await reconcileUnit(host, session.name, window, rec, unit, handles, runtimeId, vanished, scan.views)
          if (rec.tabs[unit.key] && handles.has(rec.tabs[unit.key].handle)) {
            aliveSessions.add(session.name)
          }
        }
      }
    }

    await Promise.all([...cardsSeen].map(([key, card]) => syncCardMeta(host, key, card)))

    await syncNestedRepos(host, scan, { repos, reposByPath, worktrees, cardsSeen, ownGroups, terminals })

    // Git project cards this tool registered and no window uses any more: unregister after 2 min
    // (repo.rm only drops Orca's record; the repo itself is untouched).
    const usedRepos = new Set([...cardsSeen.values()].map((c) => c.rec.repo).filter(Boolean))
    for (const own of state.repos.filter((r) => r.startsWith(`${host}/`))) {
      const repoId = own.slice(host.length + 1)
      if (usedRepos.has(repoId) || !repos.has(repoId)) {
        repoUnusedSince.delete(repoId)
        if (!repos.has(repoId)) {
          state.repos = state.repos.filter((r) => r !== own)
        }
        continue
      }
      const since = repoUnusedSince.get(repoId) ?? Date.now()
      repoUnusedSince.set(repoId, since)
      const busy = (terminals ?? []).some((t) => t.worktreeId.startsWith(`${repoId}::`))
      if (Date.now() - since >= 120_000 && !busy) {
        await rpc(host, 'repo.rm', { repo: `id:${repoId}` }).then(
          () => log(`removed unused git card ${repos.get(repoId).path}`),
          (err) => log(`removing git card failed: ${err.message}`)
        )
        state.repos = state.repos.filter((r) => r !== own)
        repoUnusedSince.delete(repoId)
      }
    }

    // 3. A workspace the user just added to one of our groups becomes a new tmux window there.
    // Only fresh ones (2 min), never one this tool created, one per pass: a stale untracked
    // workspace is debris from an earlier run and is removed instead of spawning windows.
    const sessionByGroup = new Map(
      Object.entries(state.groups)
        .filter(([k]) => k.startsWith(`${host}/`) && !k.includes('\u0000')) // not the login group
        .map(([k, id]) => [id, k.slice(host.length + 1)])
    )
    const ownWorkspaces = new Set(Object.values(state.windows).map((r) => r.fw))
    ownWorkspaces.add(state.relay?.[host]?.fw) // the relay's hidden workspace (lib/relay.mjs)
    let adoptedThisPass = false
    for (const fw of workspaces.values()) {
      const session = sessionByGroup.get(fw.projectGroupId)
      if (!session || ownWorkspaces.has(fw.id)) {
        continue
      }
      const fresh = Date.now() - (fw.createdAt ?? 0) < 120_000
      if (!fresh || createdWorkspaces.has(fw.id) || adoptFailed.has(fw.id)) {
        await rpc(host, 'folderWorkspace.delete', { folderWorkspaceId: fw.id }).catch(() => {})
        log(`removed untracked workspace ${fw.name}`)
        continue
      }
      if (adoptedThisPass) {
        continue
      }
      adoptedThisPass = true
      try {
        const windowId = await newTmuxWindow(host, session, fw.folderPath)
        // The agent picked in Orca's new-workspace dialog (or a "claude <name>" / "codex <name>"
        // name) starts in the new window's shell, so the window outlives the agent.
        const prefixed = fw.name.match(/^(claude|codex)\b\s*(.*)$/i)
        const kind = fw.createdWithAgent ?? prefixed?.[1].toLowerCase()
        const title = fw.createdWithAgent ? (/ workspace$/.test(fw.name) ? '' : fw.name) : (prefixed?.[2] ?? '')
        if (kind) {
          await startAgent(host, windowId, kind, title)
        }
        if (fw.createdWithAgent) {
          agentLaunchedAt.set(`folder:${fw.id}`, Date.now()) // Orca's own agent tab there is closed
        }
        const key = `${host}/${windowId}`
        state.windows[key] = { fw: fw.id, group: fw.projectGroupId, name: fw.name, folder: fw.folderPath }
        createdThisTick.add(key)
        log(`new workspace became tmux window ${key}`)
      } catch (err) {
        adoptFailed.add(fw.id)
        log(`could not create a window for workspace ${fw.name}: ${err.message}`)
      }
    }

    // 4. Kill-or-keep per session: exactly one tab gone while siblings live on = the user closed it.
    for (const [session, list] of Map.groupBy(vanished, (v) => v.session)) {
      // A removed card is a deliberate act (Orca never removes workspaces by itself), so it closes
      // its window even when that is the session's last; but never under a working or waiting agent.
      const [only] = list
      const busy = only.cardRemoved && only.window.panes.some((p) => p.agent && (p.state === 'working' || p.state === 'waiting'))
      if (list.length === 1 && (aliveSessions.has(session) || only.cardRemoved) && !busy && loadConfig().closeTabKillsWindow) {
        // A pane tab closes that pane (its agent); a window tab closes the window.
        const [{ window, paneId }] = list
        const target = paneId ? `pane ${paneId}` : 'window'
        const why = only.cardRemoved ? 'card removed by user' : 'tab closed by user'
        log(`${why}; killing tmux ${target} in ${host} ${session}:${window.index} ${window.name}`)
        await remoteTmux(host, paneId ? `tmux kill-pane -t ${shq(paneId)}` : `tmux kill-window -t ${shq(window.id)}`).catch(() => {})
        if (!paneId) {
          liveWindows.delete(`${host}/${window.id}`)
        }
      } else {
        // Several at once (workspace slept, Orca restarting) or the session's last one: keep.
        for (const { unitKey, windowKey } of list) {
          if (unitKey) {
            dismissed.add(unitKey)
          }
          if (windowKey) {
            removedWindows.add(windowKey)
          }
        }
      }
    }

    // 5. Windows and sessions that no longer exist in tmux.
    for (const key of [...removedWindows].filter((k) => k.startsWith(`${host}/`) && !liveWindows.has(k))) {
      removedWindows.delete(key)
    }
    for (const [key, rec] of Object.entries(state.windows)) {
      if (!key.startsWith(`${host}/`) || liveWindows.has(key) || createdThisTick.has(key)) {
        continue
      }
      await retireCard(host, rec)
      delete state.windows[key]
    }
    const liveSessions = new Set(scan.sessions.map((s) => `${host}/${s.name}`))
    for (const [groupKey, id] of Object.entries(state.groups)) {
      if (groupKey.startsWith(`${host}/`) && !groupKey.includes('\u0000') && !liveSessions.has(groupKey) && !adoptedGroups.has(groupKey)) {
        await rpc(host, 'projectGroup.delete', { groupId: id }).catch(() => {})
        delete state.groups[groupKey]
      }
    }

    // Orca's terminal daemon keeps PTYs alive after their folder workspace is deleted; nothing can
    // show them any more, so close them.
    for (const t of terminals ?? []) {
      if (t.worktreeId.startsWith('folder:') && !workspaces.has(t.worktreeId.slice('folder:'.length))) {
        await closeOwnTerminal(host, t.handle)
      }
    }
    // Orca's saved UI state can respawn default shells for projects that were unregistered
    // (cards from older layouts of this tool). Only plain "Terminal N" shells are closed.
    if (host === 'local') {
      const repoIds = new Set(repos.keys())
      for (const t of terminals ?? []) {
        const repoId = t.worktreeId.includes('::') ? t.worktreeId.split('::')[0] : null
        if (repoId && !repoIds.has(repoId) && /^Terminal \d+$/.test(t.title ?? '')) {
          await closeOwnTerminal(host, t.handle)
        }
      }
    }

    await Promise.all(passTasks.get(host) ?? [])
    passTasks.delete(host)
    forgetGone(host, scan, cardsSeen)
    // One round trip for this pass's tmux writes (each costs a second or two through the relay).
    // Status first: Orca drops a title-only completion while the pane's status still says working,
    // so "done" (with the answer) must be there when the title turns idle. Views of gone
    // windows/panes would otherwise fall through to a different window.
    const stale = [...scan.views.keys()].filter((v) => !liveViews.has(v))
    const commands = [...agentStatusCommands(scan), ...paneTitleCommands(scan), ...stale.map((v) => `tmux kill-session -t ${shq('=' + v)} 2>/dev/null`)]
    if (commands.length) {
      await remoteTmux(host, ['PATH=$PATH:/opt/homebrew/bin:/usr/local/bin', ...commands, 'true'].join('; ')).catch((err) => {
        log(`tmux updates on ${host} failed: ${err.message}`)
        // Not written: send these again next pass.
        for (const map of [statusSent, paneTitles]) {
          for (const key of [...map.keys()].filter((k) => k.startsWith(`${host}/`))) {
            map.delete(key)
          }
        }
      })
    }
  }

  // Session renames, either way. tmux keeps a session's id when it is renamed, so its group
  // follows the new name; a group renamed in Orca (with or without the "<host> · " prefix) renames
  // its session. scan.sessions is updated in place so the rest of the pass uses the new names.
  async function syncSessionNames(host, scan, groups) {
    state.sessionIds ??= {}
    const keyById = new Map(
      Object.entries(state.sessionIds)
        .filter(([k]) => k.startsWith(`${host}/`))
        .map(([k, id]) => [id, k])
    )
    const handled = new Set()
    for (const session of scan.sessions) {
      const key = `${host}/${session.name}`
      const oldKey = keyById.get(session.id)
      if (!session.id || !oldKey || oldKey === key || !state.groups[oldKey] || state.groups[key]) {
        continue
      }
      state.groups[key] = state.groups[oldKey]
      delete state.groups[oldKey]
      delete state.sessionIds[oldKey]
      handled.add(session.id)
      const name = `${host} · ${session.name}`
      await rpc(host, 'projectGroup.update', { groupId: state.groups[key], updates: { name } }).then(
        () => log(`tmux session renamed; group is now ${name}`),
        () => {}
      )
    }
    for (const session of scan.sessions) {
      const key = `${host}/${session.name}`
      const group = groups.find((g) => g.id === state.groups[key])
      const canonical = `${host} · ${session.name}`
      if (!group || handled.has(session.id) || group.name === canonical) {
        continue
      }
      const wanted = (group.name.startsWith(`${host} · `) ? group.name.slice(`${host} · `.length) : group.name)
        .trim()
        .replace(/[.:]/g, '_') // tmux forbids . and : in session names
      if (wanted && !scan.sessions.some((s) => s.name === wanted)) {
        const renamed = await remoteTmux(
          host,
          `PATH=$PATH:/opt/homebrew/bin:/usr/local/bin; tmux -u rename-session -t ${shq(`=${session.name}`)} ${shq(wanted)}`
        ).then(
          () => true,
          (err) => (log(`rename-session failed: ${err.message}`), false)
        )
        if (renamed) {
          log(`group renamed; tmux session ${host}/${session.name} is now ${wanted}`)
          state.groups[`${host}/${wanted}`] = state.groups[key]
          delete state.groups[key]
          delete state.sessionIds[key]
          session.name = wanted
        }
      }
      // Normalized ("<host> · <name>"), or back to the session's name when it could not be renamed.
      await rpc(host, 'projectGroup.update', { groupId: group.id, updates: { name: `${host} · ${session.name}` } }).catch(() => {})
    }
    for (const session of scan.sessions) {
      if (session.id) {
        state.sessionIds[`${host}/${session.name}`] = session.id
      }
    }
  }

  // Changed repos nested in a non-git window's folder (e.g. a checkout or worktree under it) get a git
  // card so their diff is one click away, parked in their own lane so they don't crowd the agents.
  // Scanned once a minute; a card leaves 10 minutes after its repo is clean again.
  async function syncNestedRepos(host, scan, { repos, reposByPath, worktrees, cardsSeen, ownGroups, terminals }) {
    const config = loadConfig()
    if (!config.nestedRepoLane || config.gitCards === false) {
      return
    }
    if (Date.now() - laneCache.at > 60_000) {
      const ui = await rpc('local', 'ui.get', null).catch(() => null)
      laneCache = { at: Date.now(), lanes: ui?.ui?.workspaceStatuses ?? [] } // ui.get answers { ui: {...} }
    }
    const lane = laneCache.lanes.find((l) => l.label === config.nestedRepoLane || l.id === config.nestedRepoLane)

    // Folders of this host's non-git windows (home is too broad to search).
    const folders = new Map() // folder -> { name, groupId }
    const windowRoots = new Set()
    for (const session of scan.sessions) {
      for (const window of session.windows) {
        if (window.gitRoot) {
          windowRoots.add(window.gitRoot)
        } else if (window.path && window.path !== scan.home && window.path !== '/' && !folders.has(window.path)) {
          folders.set(window.path, { name: window.name, groupId: state.groups[`${host}/${session.name}`] })
        }
      }
    }
    let last = nestedScans.get(host)
    if (lane && folders.size && (!last || Date.now() - last.at > 60_000)) {
      const script = [...folders.keys()]
        .map(
          (d) =>
            `find ${shq(d)} -mindepth 2 -maxdepth 3 -name node_modules -prune -o -name .git -print -prune 2>/dev/null | while read -r g; do r="\${g%/.git}"; if [ -n "$(git -C "$r" status --porcelain 2>/dev/null | head -1)" ]; then printf '%s\t%s\n' ${shq(d)} "$r"; fi; done`
        )
        .join('; ')
      // Not waited for (find and git status can take a second): its result is used from the next pass.
      const entry = { at: Date.now(), changed: last?.changed ?? [] }
      nestedScans.set(host, entry)
      remoteTmux(host, `${script}; true`).then(
        (out) => {
          entry.changed = out
            .split('\n')
            .map((line) => line.split('\t'))
            .filter(([folder, path]) => folder && path)
            .map(([folder, path]) => ({ folder, path }))
          lastFull.delete(host) // a full pass next, not one skipped as unchanged
        },
        () => {}
      )
      last = entry
    }
    const changed = lane ? (last?.changed ?? []).filter((c) => folders.has(c.folder)) : []
    const skip = (c) =>
      windowRoots.has(c.path) || nestedDismissed.has(`${host}/${c.path}`) || (host === 'local' && c.path === TOOL_ROOT)
    const wanted = new Map(changed.filter((c) => !skip(c)).map((c) => [c.path, c]))

    // Tracked nested cards: removed by the user, taken over by a window, or clean for 10 minutes.
    for (const [own, entry] of Object.entries(state.nested).filter(([k]) => k.startsWith(`${host}/`))) {
      const repoId = own.slice(host.length + 1)
      if (!repos.has(repoId)) {
        nestedDismissed.add(`${host}/${entry.path}`)
        delete state.nested[own]
      } else if (windowRoots.has(entry.path)) {
        state.repos.push(own) // a window now works in it: it becomes that window's card
        delete state.nested[own]
      } else if (wanted.has(entry.path)) {
        delete entry.cleanSince
      } else {
        entry.cleanSince ??= Date.now()
        const busy = (terminals ?? []).some((t) => t.worktreeId.startsWith(`${repoId}::`))
        if (Date.now() - entry.cleanSince >= 600_000 && !busy) {
          await rpc(host, 'repo.rm', { repo: `id:${repoId}` }).catch(() => {})
          delete state.nested[own]
        }
      }
    }

    for (const { folder, path } of wanted.values()) {
      if (nestedDismissed.has(`${host}/${path}`)) {
        continue // removed by the user during this very pass
      }
      const { name, groupId } = folders.get(folder)
      let repo = reposByPath.get(path)
      if (!repo) {
        ;({ repo } = await rpc(host, 'repo.add', { path, kind: 'git', displayName: basename(path) }).catch(() => ({})))
        if (!repo) {
          continue
        }
        state.nested[`${host}/${repo.id}`] = { path }
        repos.set(repo.id, repo)
        reposByPath.set(path, repo)
        log(`added changed nested repo ${path}`)
      }
      if (!state.nested[`${host}/${repo.id}`]) {
        continue // a repo the user (or a window) already has: leave it be
      }
      if (repo.projectGroupId !== groupId && !ownGroups.has(repo.projectGroupId)) {
        await rpc(host, 'projectGroup.moveProject', { repo: `id:${repo.id}`, groupId }).catch(() => {})
        repo.projectGroupId = groupId
      }
      const meta = worktrees.get(`${repo.id}::${path}`) ?? {}
      const displayName = `${name}/${path.slice(folder.length + 1)}`
      const updates = {}
      if (meta.workspaceStatus !== lane.id) {
        updates.workspaceStatus = lane.id
      }
      if (meta.displayName !== displayName) {
        updates.displayName = displayName
      }
      if (Object.keys(updates).length) {
        await rpc(host, 'worktree.set', { worktree: `id:${repo.id}::${path}`, ...updates }).catch(() => {})
      }
    }
  }

  // A card's lane follows its most urgent agent (across all windows on it): waiting > working >
  // idle (recently finished vs. idle for a while) > no agent. A lane the user picked by hand sticks
  // until they move it to the lane this would choose anyway. "Manual" sort becomes agent-activity
  // order; git project cards also get lastActivityAt, so "Recent" sort works there.
  async function syncCardMeta(host, key, { rec, windows, meta }) {
    const config = loadConfig()
    if (!meta) {
      return
    }
    const book = (state.cards[`${host}/${key}`] ??= {})
    const agents = windows.flatMap(({ window }) => window.panes.filter((p) => p.agent))
    const agentState = ['waiting', 'working', 'idle'].find((st) => agents.some((p) => p.state === st)) ?? 'none'
    const lastChange = Math.max(0, ...agents.map((p) => p.since ?? 0))
    const updates = {}

    // Orca marks a card unread on title changes it reads as a finished turn, including ones caused
    // by tabs being recreated. Keep the mark only for completions/approvals seen in tmux.
    const windowKeys = windows.map(({ window }) => `${host}/${window.id}`)
    if (!meta.isUnread) {
      windowKeys.forEach((k) => attention.delete(k))
    } else if (!windowKeys.some((k) => attention.has(k))) {
      updates.isUnread = false
    }

    const map = config.autoStatus
    if (map) {
      const stale = agentState === 'idle' && Date.now() - lastChange >= (config.laterAfterMin ?? 60) * 60_000
      const desired = (stale && map.later) || map[agentState]
      if (book.autoStatus !== undefined && meta.workspaceStatus !== book.autoStatus) {
        book.manualStatus = meta.workspaceStatus !== desired
      }
      if (desired && !book.manualStatus && meta.workspaceStatus !== desired) {
        updates.workspaceStatus = desired
      }
      if (desired && !book.manualStatus) {
        book.autoStatus = desired
      }
    }

    if (config.activityOrder !== false) {
      const firstIndex = Math.min(...windows.map(({ window }) => window.index))
      const tier = { waiting: 4e12, working: 3e12, idle: 0, none: 0 }[agentState]
      const order = agentState === 'none' ? 1000 - firstIndex : tier + lastChange
      if (book.order !== order) {
        updates.manualOrder = order
      }
    }

    if (rec.repo) {
      // One window: name the card after it, like folder workspaces; shared: the repo's name.
      const mark = hostMark(host, config)
      const displayName = windows.length === 1 ? cardName(windows[0].window, mark) : [mark, basename(rec.root)].filter(Boolean).join(' ')
      if (meta.displayName !== displayName) {
        updates.displayName = displayName
      }
      if (lastChange && meta.lastActivityAt !== lastChange) {
        updates.lastActivityAt = lastChange
      }
      // The Linear issue in the branch name, linked once (if Orca is connected to Linear and the issue
      // exists); a link someone removed is not added back.
      const issue = branchIssue(meta.branch)
      if (issue && !meta.linkedLinearIssue && book.linear !== issue && (await linearIssueExists(issue))) {
        updates.linkedLinearIssue = issue
        book.linear = issue
      }
    }

    // A card several windows share lists them in its note. A note someone wrote is left alone.
    const note = windows.length > 1 ? windows.map(({ window }) => cardName(window)).join(' · ') : ''
    if ((meta.comment ?? '') !== note && (!meta.comment || meta.comment === book.note)) {
      updates.comment = note
    }
    book.note = note

    if (Object.keys(updates).length) {
      const call = rec.repo
        ? rpc(host, 'worktree.set', { worktree: cardSelector(rec), ...updates })
        : rpc(host, 'folderWorkspace.update', { folderWorkspaceId: rec.fw, updates })
      await call.then(
        () => {
          if (updates.workspaceStatus) {
            book.autoStatus = updates.workspaceStatus
          }
          if (updates.manualOrder !== undefined) {
            book.order = updates.manualOrder
          }
        },
        (err) => log(`status/order for ${rec.name} failed: ${err.message}`)
      )
    }
  }

  async function linearIssueExists(issue) {
    if (Date.now() - linearCheck.at > 300_000) {
      const status = await rpc('local', 'linear.status', {}).catch(() => null)
      linearCheck = { at: Date.now(), connected: status?.connected === true }
    }
    if (!linearCheck.connected) {
      return false
    }
    if (!linearIssues.has(issue)) {
      const found = await rpc('local', 'linear.getIssue', { id: issue }).then(
        (r) => Boolean(r?.issue ?? r?.identifier ?? r?.id),
        () => false
      )
      linearIssues.set(issue, found)
    }
    return linearIssues.get(issue)
  }

  function tabUnits(host, window) {
    const key = `${host}/${window.id}`
    const agents = window.panes.filter((p) => p.agent)
    if (agents.length === 0) {
      return [{ key, view: unitViewName(window.id, null), paneId: null, title: windowTitle(window) }]
    }
    // "3m · <task>" (3 minutes idle, or working, or waiting): Orca shows the agent's icon and
    // status in front of the tab already. Without
    // a task, the agent's name (with the pane number when the kind repeats).
    return agents.map((pane) => {
      const repeated = agents.filter((p) => p.agent === pane.agent).length > 1
      const label = agentTask(pane) || (repeated ? `${pane.agent} ${pane.index}` : pane.agent)
      return {
        key: `${key}/${pane.id}`,
        view: unitViewName(window.id, pane.id),
        paneId: pane.id,
        title: [stateAge(pane), label].filter(Boolean).join(' · ')
      }
    })
  }

  function forgetUnit(unitKey) {
    for (const map of [everAttached, dismissed, pending, failures, suspects]) {
      map.delete(unitKey)
    }
  }

  // "+" in a window's card opens a new tmux window, with a card of its own, at once: the window is
  // created as soon as the tab shows up, its tab gets focus when it opens, and the "+" tab closes
  // quietly once it has settled (PLUS_SETTLE_MS) - long enough to see whether Claude/Codex was
  // picked in the "+" menu, which then runs in the new window instead.
  // The window a "+" opens: the next number in the session, named after the shell like the plain
  // windows there. Its card gets this name at once instead of a placeholder renamed a moment later.
  function nextWindow(host, windows) {
    const shell = windows.find((w) => w.autoName && !w.panes.some((p) => p.agent) && /^-?(zsh|bash|fish|sh|dash|ksh)$/.test(w.name))?.name
    return {
      index: Math.max(-1, ...windows.map((w) => w.index)) + 1,
      name: shell ?? (host === 'local' ? basename(process.env.SHELL || 'zsh') : 'bash')
    }
  }

  async function adoptPlusTabs(host, session, rec, handles, windows = []) {
    const key = cardKey(rec)
    const own = ownedHandles(host, key)
    const fresh = Date.now() - (cardCreatedAt.get(key) ?? 0) < 30_000
    for (const handle of handles) {
      if (own.has(handle) || closedByUs.has(handle)) {
        continue
      }
      if (fresh && rec.repo) {
        await closeOwnTerminal(host, handle) // Orca's default shell in a newly added git project
        continue
      }
      if (Date.now() - (agentLaunchedAt.get(key) ?? 0) < 30_000) {
        await closeOwnTerminal(host, handle) // the dialog's agent tab: the agent runs in tmux instead
        continue
      }
      if (!baselined.has(key) && !cardCreatedAt.has(key)) {
        continue // already there when this run started
      }
      const plus = plusTabs.get(handle)
      if (!plus) {
        plusTabs.set(handle, { host, windowId: null, at: Date.now() })
        // The window and its folder card are created at the same time (two round trips at once).
        const next = nextWindow(host, windows)
        const name = cardName({ ...next, autoName: true, panes: [] }, hostMark(host, loadConfig()))
        const fwCreated = rec.repo
          ? null
          : rpc(host, 'folderWorkspace.create', { projectGroupId: rec.group, name, folderPath: rec.folder }).then((r) => {
              createdWorkspaces.add(r.folderWorkspace.id)
              cardCreatedAt.set(`folder:${r.folderWorkspace.id}`, Date.now())
              return r
            })
        fwCreated?.catch(() => {})
        await openTmuxWindow(host, session, rec.folder, next.index).then(
          async (win) => {
            plusTabs.get(handle).windowId = win.id
            log(`"+" opened tmux window ${host}/${win.id}`)
            await openWindowCard(host, session, rec, win, fwCreated).catch((err) => log(`card for ${host}/${win.id} failed: ${err.message}`))
          },
          async (err) => {
            log(`could not open a new window: ${err.message}`)
            const created = await fwCreated?.catch(() => null)
            if (created) {
              await rpc(host, 'folderWorkspace.delete', { folderWorkspaceId: created.folderWorkspace.id }).catch(() => {})
            }
          }
        )
        continue
      }
      if (Date.now() - plus.at < PLUS_SETTLE_MS) {
        continue
      }
      // A Claude/Codex picked in the "+" menu runs in the new window instead of the Orca tab; one
      // Orca resumed (session history) keeps its conversation there.
      const agent = plus.windowId ? await tabAgent(host, handle) : null
      const resume = agent
        ? resumeArgs(agent, findOrcaAgentArgs(await remoteTmux(host, 'ps -eo pid=,ppid=,etime=,args=').catch(() => ''), agent))
        : ''
      await closeOwnTerminal(host, handle)
      plusTabs.delete(handle)
      if (agent) {
        await startAgent(host, plus.windowId, agent, '', resume)
        log(`${agent} from the "+" menu runs in ${host}/${plus.windowId}${resume ? ` (${resume})` : ''}`)
      }
    }
    baselined.add(key)
  }

  async function reconcileUnit(host, session, window, rec, unit, handles, runtimeId, vanished, views) {
    const { key } = unit
    const attached = views.get(unit.view)?.attached === true
    let tab = rec.tabs[key]

    // Tab whose view vanished: detached (tab still open) or closed (tab gone). Orca keeps listing
    // a closed tab for ~2s, so decide only once the state has persisted.
    if (tab && everAttached.has(key) && !attached) {
      const since = suspects.get(key)
      if (!since) {
        suspects.set(key, Date.now())
        return
      }
      if (Date.now() - since < SETTLE_MS) {
        return
      }
      suspects.delete(key)
      everAttached.delete(key)
      delete rec.tabs[key]
      if (handles.has(tab.handle)) {
        // The attach ended (ssh drop, prefix-d) but the tab is open: reopen it below.
        await closeOwnTerminal(host, tab.handle)
      } else if (runtimeId && tab.runtimeId === runtimeId) {
        vanished.push({ window, paneId: unit.paneId, session, unitKey: key })
        return
      }
      tab = undefined // Otherwise Orca restarted: just recreate.
    } else {
      suspects.delete(key)
    }

    // A view attached by some other client (e.g. a tab from an older layout) still needs our tab.
    if (attached && tab) {
      everAttached.add(key)
      pending.delete(key)
      failures.delete(key)
      tab.runtimeId = runtimeId
      if (tab.title !== unit.title) {
        later(
          host,
          rpc(host, 'terminal.rename', { terminal: tab.handle, title: unit.title }).then(
            () => (tab.title = unit.title),
            () => {}
          )
        )
      }
      return
    }
    if (dismissed.has(key) || suspects.has(key)) {
      return
    }
    const createdAt = pending.get(key)
    if (createdAt && Date.now() - createdAt < 30_000) {
      return
    }
    const failure = failures.get(key)
    if (failure && Date.now() < failure.retryAt) {
      return
    }
    if (createdAt) {
      // A tab was created but never attached; back off.
      const count = (failure?.count ?? 0) + 1
      failures.set(key, { count, retryAt: Date.now() + Math.min(30, 2 ** count) * 60_000 })
      pending.delete(key)
      log(`attach did not complete for ${key}; retrying later`)
      return
    }
    if (tab) {
      await closeOwnTerminal(host, tab.handle)
    }
    const { terminal } = await rpc(host, 'terminal.create', {
      worktree: cardSelector(rec),
      title: unit.title,
      command: attachCommand(session, window.id, unit.paneId)
    })
    rec.tabs[key] = { handle: terminal.handle, title: unit.title }
    pending.set(key, Date.now())
  }

  function paneTitleCommands(scan) {
    const commands = []
    for (const session of scan.sessions) {
      for (const window of session.windows) {
        for (const pane of window.panes) {
          const key = `${scan.host}/${pane.id}`
          const title = pane.agent ? orcaTitle(pane) : null
          if (paneTitles.get(key) === title) {
            continue
          }
          paneTitles.set(key, title)
          // -u: without a UTF-8 locale (launchd) tmux would replace non-ASCII text with "_".
          commands.push(
            title === null
              ? `tmux set -pu -t ${pane.id} @orca_title`
              : `tmux -u set -p -t ${pane.id} @orca_title ${shq(title)}`
          )
        }
      }
    }
    if (commands.length) {
      // Redraw view clients so set-titles pushes the new title immediately.
      commands.push(
        `for c in $(tmux list-clients -F '#{client_name} #{session_name}' | awk '$2 ~ /^orca-[wp][0-9]+$/ {print $1}'); do tmux refresh-client -S -t "$c"; done`
      )
    }
    return commands
  }

  // Written straight to each pane tab's terminal: tmux would drop the sequence coming from the pane.
  // Resent when the state or the tab changes, and periodically (below).
  function agentStatusCommands(scan) {
    if (loadConfig().statusBridge === false) {
      return []
    }
    const now = Date.now()
    const commands = []
    for (const pane of scan.sessions.flatMap((s) => s.windows.flatMap((w) => w.panes))) {
      const key = `${scan.host}/${pane.id}`
      const tty = scan.views.get(`orca-p${pane.id.slice(1)}`)?.tty
      if (!pane.agent || !tty || !/^\/dev\/[\w/]+$/.test(tty)) {
        statusSent.delete(key)
        continue
      }
      const json = JSON.stringify(agentStatusPayload(pane, now))
      const sent = statusSent.get(key)
      // Resent now and then: Orca expires a record after 30 minutes, and for an SSH host's tab the
      // desktop reads records only while the tab is mounted (seen recently), so a "done" written
      // while it was parked is lost and the desktop row stays "working". Every minute there means a
      // look at the tab fixes it within a minute.
      const refreshMs = scan.host === 'local' ? 600_000 : 60_000
      if (sent && sent.json === json && sent.tty === tty && now - sent.at < refreshMs) {
        continue
      }
      statusSent.set(key, { json, tty, at: now })
      // Terminated by ST (ESC \), not BEL: this write can land between tmux's own output, and a BEL
      // that loses its OSC there would ring as a terminal bell ("Bell in … attention requested").
      commands.push(`printf '\\033]9999;%s\\033\\\\' ${shq(json)} > ${tty}`)
    }
    return commands
  }

  function trackAgentStates(host, sessionName, window) {
    for (const pane of window.panes) {
      const key = `${host}/${pane.id}`
      if (pane.agent) {
        const record = state.panes[key]
        // A turn that started and finished between two scans never shows as "working": a new
        // "done" footer or a new last answer while idle is that turn, finished now.
        const missedTurn =
          record?.state === 'idle' &&
          pane.state === 'idle' &&
          ((pane.doneAt && record.doneAt && pane.doneAt > record.doneAt) ||
            (pane.message && record.message !== undefined && pane.message !== record.message))
        if (record?.state !== pane.state || missedTurn) {
          state.panes[key] = { state: pane.state, since: Date.now() }
        }
        // The agent's own "done at" footer is a better idle start than when we first noticed.
        if (pane.state === 'idle' && pane.doneAt && pane.doneAt < state.panes[key].since && !missedTurn) {
          state.panes[key].since = pane.doneAt
        }
        if (pane.state === 'idle') {
          state.panes[key].doneAt = pane.doneAt ?? null
          state.panes[key].message = pane.message ?? ''
        }
        pane.since = state.panes[key].since
        if (missedTurn) {
          attention.add(`${host}/${window.id}`)
        }
      } else {
        delete state.panes[key]
      }
      const previous = agentStates.get(key)
      agentStates.set(key, pane.agent ? pane.state : null)
      // Real reasons for Orca's unread mark: a finished turn or a pending approval.
      if (pane.agent && ((previous === 'working' && pane.state !== 'working') || pane.state === 'waiting')) {
        attention.add(`${host}/${window.id}`)
      }
      if (previous === 'working' && pane.agent && pane.state === 'idle') {
        const where = host === 'local' ? '' : `${host} · `
        void notify(`${pane.agent} 완료`, `${where}${sessionName}:${window.index}.${pane.index} ${pane.title.replace(/^\S+\s/, '')}`)
      }
    }
  }

  // --- password login for hosts system ssh cannot reach without one ------------------------

  function masterAlive(host) {
    return sh('ssh', ['-O', 'check', '-o', `ControlPath=${controlPath()}`, host], env).then(
      () => true,
      () => false
    )
  }

  // Login tabs live in a temporary local "tmux 로그인" workspace. ssh reads the password straight
  // from the tab's terminal; this process never sees it. The resulting master (ControlPersist) is
  // shared by scans and tmux commands.
  async function ensureLoginWorkspace() {
    const { folderWorkspaces } = await rpc('local', 'folderWorkspace.list', {})
    if (loginWorkspace && folderWorkspaces.some((fw) => fw.id === loginWorkspace)) {
      return loginWorkspace
    }
    const groupKey = 'local/\u0000login'
    // Reuse the workspace a previous run left behind instead of stacking new ones.
    const leftover = folderWorkspaces.find((fw) => fw.projectGroupId === state.groups[groupKey])
    if (leftover) {
      loginWorkspace = leftover.id
      return loginWorkspace
    }
    const { groups } = await rpc('local', 'projectGroup.list', null)
    if (!groups.some((g) => g.id === state.groups[groupKey])) {
      const { group } = await rpc('local', 'projectGroup.create', { name: 'tmux 로그인', parentPath: homedir() })
      state.groups[groupKey] = group.id
    }
    const { folderWorkspace } = await rpc('local', 'folderWorkspace.create', {
      projectGroupId: state.groups[groupKey],
      name: 'ssh 로그인',
      folderPath: homedir()
    })
    loginWorkspace = folderWorkspace.id
    return loginWorkspace
  }

  async function dropLoginWorkspaceIfIdle() {
    const groupKey = 'local/\u0000login'
    if (loginTabs.size === 0 && state.groups[groupKey]) {
      // Also the workspace a previous run left (this run never knew its id).
      const { folderWorkspaces } = await rpc('local', 'folderWorkspace.list', {}).catch(() => ({ folderWorkspaces: [] }))
      for (const fw of folderWorkspaces.filter((w) => w.projectGroupId === state.groups[groupKey] || w.id === loginWorkspace)) {
        await rpc('local', 'folderWorkspace.delete', { folderWorkspaceId: fw.id }).catch(() => {})
      }
      await rpc('local', 'projectGroup.delete', { groupId: state.groups[groupKey] }).catch(() => {})
      delete state.groups[groupKey]
      loginWorkspace = null
    }
  }

  async function openLoginTab(host) {
    const cooldown = loginCooldown.get(host)
    if (loginTabs.has(host) || (cooldown && Date.now() < cooldown)) {
      return
    }
    const fw = await ensureLoginWorkspace()
    const { terminals } = await rpc('local', 'terminal.list', { limit: 1000 })
    const existing = terminals.find((t) => t.worktreeId === `folder:${fw}` && t.title === `${host} 로그인`)
    if (existing) {
      loginTabs.set(host, { handle: existing.handle }) // still open from a previous run
      return
    }
    const { terminal } = await rpc('local', 'terminal.create', {
      worktree: `folder:${fw}`,
      title: `${host} 로그인`,
      command: `/bin/bash ${shq(LOGIN)} ${shq(host)}`
    })
    loginTabs.set(host, { handle: terminal.handle })
    log(`opened login tab for ${host}`)
  }

  async function settleLogin(host) {
    const login = loginTabs.get(host)
    if (await masterAlive(host)) {
      loginTabs.delete(host)
      hostBackoff.delete(host)
      await closeOwnTerminal('local', login.handle)
      await dropLoginWorkspaceIfIdle()
      log(`${host} connected`)
      return true
    }
    const { terminals } = await rpc('local', 'terminal.list', { limit: 1000 }).catch(() => ({ terminals: null }))
    if (terminals && !terminals.some((t) => t.handle === login.handle)) {
      // Closed without logging in: don't ask again for a while.
      loginTabs.delete(host)
      loginCooldown.set(host, Date.now() + 10 * 60_000)
      await dropLoginWorkspaceIfIdle()
    }
    return false
  }

  async function refreshEnvironments(orcaHosts) {
    const targetName = new Map(orcaHosts.filter((h) => h.kind === 'ssh').map((h) => [h.id, h.name]))
    const list = await cli.listEnvironments().catch(() => null)
    if (!list) {
      return // keep what was known: a failed listing is not every host gone
    }
    environments = new Map(
      list
        .filter((e) => targetName.has(e.orcadDeployment?.sshTargetId))
        .map((e) => [targetName.get(e.orcadDeployment.sshTargetId), e.id])
    )
  }

  // One host's pass: scan it, then bring Orca in line with it.
  async function syncHost(host, runtimeId, connected) {
    if (loginTabs.has(host) && !(await settleLogin(host))) {
      return null // waiting for the password in the login tab
    }
    const backoff = hostBackoff.get(host)
    if (backoff && Date.now() < backoff.retryAt) {
      return null
    }
    let result
    try {
      result = scan === scanHost && viaOrca(host) ? await relay.scan(host) : await scan(host, { env })
      hostBackoff.delete(host)
    } catch (err) {
      if (err.relayStarting) {
        return null // first use or the host rebooted: the helper is coming up, try next tick
      }
      const failuresSoFar = (backoff?.failures ?? 0) + 1
      // A local scan fails only when the Mac is busy (waking from sleep): try again next pass.
      // An SSH host that fails is likely unreachable: back off for minutes.
      hostBackoff.set(host, {
        failures: failuresSoFar,
        retryAt: Date.now() + (host === 'local' ? 0 : Math.min(30, 2 ** failuresSoFar) * 60_000)
      })
      const reason = String(err.stderr || err.message).trim().split('\n').pop()
      if (failuresSoFar === 1) {
        log(`skip ${host}: ${reason}`)
      }
      if (connected.has(host) && /Permission denied|Host key verification|password/i.test(reason)) {
        await openLoginTab(host).catch((e) => log(`login tab for ${host} failed: ${e.message}`))
      }
      return null
    }
    if (host !== 'local' && !environments.has(host)) {
      if (!warned.has(host)) {
        warned.add(host)
        log(`${host}: no Orca server (orcad) for this host yet; connect it in Orca to mirror it`)
      }
      return null
    }
    for (const key of [...createdThisTick].filter((k) => k.startsWith(`${host}/`))) {
      createdThisTick.delete(key)
    }
    try {
      await reconcileHost(result, runtimeId)
    } catch (err) {
      log(`sync ${host} failed: ${err.message}`)
    }
    // A tab settling or just created needs another look soon, not after the next change.
    const recent = (map) => [...map.values()].some((at) => Date.now() - at < 20_000)
    if ([...plusTabs.values()].some((p) => p.host === host) || recent(suspects) || recent(pending) || [...createdThisTick].some((k) => k.startsWith(`${host}/`))) {
      followUp.add(host)
    } else {
      followUp.delete(host)
    }
    return result
  }

  // Bookkeeping for panes, cards and sessions that are gone, so state.json and the maps stay small.
  function forgetGone(host, scan, cardsSeen) {
    const mine = (k) => k.startsWith(`${host}/`)
    const panes = new Set(scan.sessions.flatMap((s) => s.windows.flatMap((w) => w.panes.map((p) => `${host}/${p.id}`))))
    const sessions = new Set(scan.sessions.map((s) => `${host}/${s.name}`))
    const cards = new Set([...cardsSeen.keys()].map((k) => `${host}/${k}`))
    const drop = (keys, live) => keys.filter((k) => mine(k) && !live.has(k))
    for (const k of drop(Object.keys(state.panes), panes)) delete state.panes[k]
    for (const k of drop(Object.keys(state.cards), cards)) delete state.cards[k]
    for (const k of drop(Object.keys(state.sessionIds ?? {}), sessions)) delete state.sessionIds[k]
    for (const map of [statusSent, paneTitles, agentStates]) {
      for (const k of drop([...map.keys()], panes)) map.delete(k)
    }
    const old = Date.now() - 600_000
    for (const map of [cardCreatedAt, agentLaunchedAt]) {
      for (const [k, at] of map) if (at < old) map.delete(k)
    }
  }

  function persist() {
    state.removedWindows = [...removedWindows]
    saveState(state)
  }

  async function tick() {
    const config = loadConfig()
    // Each CLI call spawns an Electron process, so Orca facts are refreshed every 30s, not every tick.
    if (Date.now() - orcaFacts.at > 30_000) {
      const runtimeId = (await cli.status().catch(() => null))?.runtime?.runtimeId ?? null
      const orcaHosts = await cli.listHosts().catch(() => [])
      await refreshEnvironments(orcaHosts)
      orcaFacts = { at: Date.now(), runtimeId, orcaHosts }
    }
    const { runtimeId, orcaHosts } = orcaFacts
    const connected = new Set(orcaHosts.filter((h) => h.kind === 'ssh' && h.connected).map((h) => h.name))
    // A login group left by an earlier run (its tab closed or no longer needed) goes away.
    await dropLoginWorkspaceIfIdle()
    if (!config.notify) {
      agentStates.clear()
    }
    const hosts = resolveHosts(config, connected)
    // SSH hosts run on lanes of their own: one with slow round trips (the relay) never holds up the
    // local pass. A host's next pass starts when its last one is done.
    for (const host of hosts.filter((h) => h !== 'local' && !lanes.has(h))) {
      lanes.set(
        host,
        syncHost(host, runtimeId, connected)
          .catch((err) => log(`sync ${host} failed: ${err.message}`))
          .finally(() => {
            lanes.delete(host)
            persist()
          })
      )
    }
    const local = hosts.includes('local') ? await syncHost('local', runtimeId, connected) : null
    persist()
    // When to look again: as soon as the earliest settling tab has settled.
    const settling = [
      ...[...plusTabs.values()].map((p) => p.at + PLUS_SETTLE_MS),
      ...[...suspects.values()].map((at) => at + SETTLE_MS)
    ].filter((at) => at > Date.now())
    const soonMs = followUp.size ? Math.max(100, Math.min(1000, ...settling.map((at) => at - Date.now() + 50))) : null
    return { soon: followUp.size > 0, soonMs, scans: [local].filter(Boolean) }
  }

  // Between passes: has any tab appeared or gone in Orca? A new "+" tab is not a tmux event, so
  // this one cheap call per host is what makes it turn into a window within a second or two.
  const probeSeen = new Map() // host -> sorted terminal handles
  async function probe() {
    // All hosts at once, each given 2s: a slow SSH host must not hold up the next local pass.
    const lists = await Promise.all(
      [...lastFull.keys()].map((host) =>
        Promise.race([rpc(host, 'terminal.list', { limit: 1000 }), sleep(2000).then(() => null)])
          .catch(() => null)
          .then((r) => [host, r?.terminals ?? null])
      )
    )
    let changed = false
    for (const [host, terminals] of lists.filter(([, t]) => t)) {
      const handles = terminals.map((t) => t.handle).sort().join(' ')
      if (probeSeen.has(host) && probeSeen.get(host) !== handles) {
        changed = true
      }
      probeSeen.set(host, handles)
    }
    return changed
  }

  async function newWindow(displayName) {
    const groupKey = Object.keys(state.groups).find((k) => {
      const slash = k.indexOf('/')
      return `${k.slice(0, slash)} · ${k.slice(slash + 1)}` === displayName
    })
    if (!groupKey) {
      return false
    }
    const slash = groupKey.indexOf('/')
    await newTmuxWindow(groupKey.slice(0, slash), groupKey.slice(slash + 1), null)
    return true
  }

  return {
    tick,
    // Resolves once the SSH hosts' passes started by the last tick are done (one-shot runs).
    settled: () => Promise.all(lanes.values()),
    probe,
    newWindow,
    reopenDismissed: () => {
      dismissed.clear()
      removedWindows.clear()
      lastFull.clear() // nothing in tmux or Orca changed: force the next full pass
    },
    config: loadConfig
  }
}
