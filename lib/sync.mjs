// Reconcile tmux into Orca: each tmux session becomes an Orca project group, each tmux window a
// folder workspace in it (named after the window, pointing at the window's current folder, so
// Orca's explorer/diff show that folder) holding one tab attached to the window. Remote hosts use
// the orcad server Orca runs on them, so their workspaces live remotely like Orca's own.
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { attachCommand, unitViewName } from './attach-command.mjs'
import { resolveHosts } from './hosts.mjs'
import { controlPath, scanHost } from './scan.mjs'

// ORCA_TMUX_HOME redirects all state (tests use a temp dir).
const ROOT = process.env.ORCA_TMUX_HOME || join(homedir(), '.orca-tmux')
const LOGIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'login.sh')
const STATE_FILE = join(ROOT, 'state.json')
const DEFAULT_CONFIG = {
  // 'orca': local + SSH hosts currently connected in Orca; 'ssh-config': every Host alias; or a list.
  hosts: 'orca',
  exclude: [],
  intervalSec: 5,
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
const SETTLE_MS = 4000
const GLYPH = { working: '⠿', idle: '✳', waiting: '✋' }

export function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')) }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

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
function loadState() {
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    return {
      groups: state.groups ?? {},
      windows: state.windows ?? {},
      panes: state.panes ?? {},
      repos: state.repos ?? [],
      cards: state.cards ?? {},
      nested: state.nested ?? {}
    }
  } catch {
    return { groups: {}, windows: {}, panes: {}, repos: [], cards: {}, nested: {} }
  }
}

function saveState(state) {
  try {
    mkdirSync(ROOT, { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  } catch {
    // best effort: a lost state file only means workspaces get recreated
  }
}

// The title Orca sees through tmux set-titles. Orca reads a braille spinner as working,
// "✳ " as idle (claude) and "<agent> - action required" as waiting for permission.
// Orca stamps title-detected agents "now", so the idle time is carried in the title instead.
export function idleAge(pane, now = Date.now()) {
  if (pane.state !== 'idle' || !pane.since) {
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

export function orcaTitle(pane) {
  const task = [pane.title.replace(/^[⠀-⣿✳✻✶✢·*]\s*/u, '').trim(), idleAge(pane)].filter(Boolean).join(' · ')
  if (pane.state === 'waiting') {
    return `${pane.agent} - action required · ${task}`
  }
  if (pane.state === 'working') {
    return `⠋ ${pane.agent} · ${task}`
  }
  return pane.agent === 'claude' ? `✳ claude · ${task}` : `${pane.agent} · ${task}`
}

export function windowTitle(window) {
  const agents = window.panes.filter((p) => p.agent)
  const summary = agents.map((p) => `${GLYPH[p.state] ?? ''}${p.agent}`).join(' ')
  return [`${window.index} ${window.name}`, summary].filter(Boolean).join(' · ')
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
  const removedWindows = new Set() // windows whose workspace the user removed but we kept
  const pending = new Map() // window key -> when its tab was created
  const failures = new Map() // window key -> { count, retryAt }
  const suspects = new Map() // window key -> when its view was first seen missing
  const createdThisTick = new Set() // windows created this tick (absent from the scan, not gone)
  const hostBackoff = new Map() // host -> { failures, retryAt }
  const agentStates = new Map() // `${host}/${paneId}` -> state, for completion notifications
  const paneTitles = new Map() // `${host}/${paneId}` -> last @orca_title written
  const seenWorkspaces = new Set() // folder workspaces confirmed to exist in this run
  const cardCreatedAt = new Map() // cardKey -> when this run created the card
  const baselined = new Set() // cardKeys whose pre-existing terminals were noted
  const seenRepos = new Set() // git project cards confirmed to exist in this run
  const repoUnusedSince = new Map() // own repo card -> when it last had no window
  const nestedScans = new Map() // host -> { at, changed: [{ folder, path }] }
  const nestedDismissed = new Set() // `${host}/${path}` nested cards the user removed
  let laneCache = { at: 0, lanes: [] }
  const plusCandidates = new Map() // `${fw}/${handle}` -> first seen
  const closedByUs = new Set() // handles we closed; they linger in listings briefly
  const adoptFailed = new Set() // user-created workspaces we could not turn into windows
  const createdWorkspaces = new Set() // workspaces this run created (never adopted as user-made)
  const attention = new Set() // windows with a real completion/approval since last read
  const loginTabs = new Map() // host -> { handle } while the password prompt is open
  const loginCooldown = new Map() // host -> no login prompt before this time
  const warned = new Set()
  let environments = new Map() // host -> orcad environment id
  let loginWorkspace = null // local workspace that hosts login tabs
  let currentScan = null
  let orcaFacts = { at: 0, runtimeId: null, orcaHosts: [] }

  const rpc = (host, method, params) => bridge.call(host === 'local' ? null : environments.get(host), method, params)

  function remoteTmux(host, script) {
    if (runTmux) {
      return runTmux(host, script)
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

  async function retireCard(host, rec) {
    for (const [unitKey, tab] of Object.entries(rec.tabs ?? {})) {
      await closeOwnTerminal(host, tab.handle)
      forgetUnit(unitKey)
    }
    if (rec.fw) {
      await rpc(host, 'folderWorkspace.delete', { folderWorkspaceId: rec.fw }).catch(() => {})
    }
  }

  async function newTmuxWindow(host, session, cwd) {
    const dir = cwd ? ` -c ${shq(cwd)}` : ''
    const id = (
      await remoteTmux(host, `PATH=$PATH:/opt/homebrew/bin:/usr/local/bin; tmux new-window -d -P -F '#{window_id}'${dir} -t ${shq(`=${session}:`)}`)
    ).trim()
    if (!/^@\d+$/.test(id)) {
      throw new Error(`unexpected window id ${JSON.stringify(id)}`)
    }
    return id
  }

  async function reconcileHost(scan, runtimeId) {
    const { host } = scan
    const [{ groups }, { folderWorkspaces }, { terminals }, { repos: repoList }, { worktrees: worktreeList }] =
      await Promise.all([
        rpc(host, 'projectGroup.list', null),
        rpc(host, 'folderWorkspace.list', {}),
        rpc(host, 'terminal.list', { limit: 1000 }),
        rpc(host, 'repo.list', {}),
        rpc(host, 'worktree.list', { limit: 1000 })
      ])
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
    // Groups named like ours but not in our state are leftovers from an earlier run (e.g. a lost
    // state file, or groups created before parentPath was set); remove them with their workspaces.
    const tracked = new Set(Object.values(state.groups))
    for (const g of groups.filter((g) => g.name.startsWith(`${host} · `) && !tracked.has(g.id))) {
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

    for (const session of scan.sessions) {
      // 1. Session -> project group.
      const groupKey = `${host}/${session.name}`
      if (!groupIds.has(state.groups[groupKey])) {
        // The sidebar only renders folder workspaces whose group has a parentPath.
        const { group } = await rpc(host, 'projectGroup.create', {
          name: `${host} · ${session.name}`,
          parentPath: scan.home || homedir()
        })
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
            vanished.push({ window, paneId: null, session: session.name, windowKey: key })
            delete state.windows[key]
            continue
          }
        }
        const name = `${window.index} ${window.name}`
        const folder = window.path || homedir()
        const root = loadConfig().gitCards !== false ? window.gitRoot : null
        if (rec && (root ? rec.root !== root : !rec.fw)) {
          // cd'd into or out of a repo: move the window to its new card (tabs reopen there).
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
          await rpc(host, 'folderWorkspace.update', {
            folderWorkspaceId: rec.fw,
            updates: { name, folderPath: folder }
          }).then(
            () => Object.assign(rec, { name, folder }),
            (err) => log(`update workspace ${name} failed: ${err.message}`)
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
        await adoptPlusTabs(host, session.name, rec, handles)
        for (const unit of units) {
          liveViews.add(unit.view)
          await reconcileUnit(host, session.name, window, rec, unit, handles, runtimeId, vanished)
          if (rec.tabs[unit.key] && handles.has(rec.tabs[unit.key].handle)) {
            aliveSessions.add(session.name)
          }
        }
      }
    }

    for (const [key, card] of cardsSeen) {
      await syncCardMeta(host, key, card)
    }

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
      if (list.length === 1 && aliveSessions.has(session) && loadConfig().closeTabKillsWindow) {
        // A pane tab closes that pane (its agent); a window tab closes the window.
        const [{ window, paneId }] = list
        const target = paneId ? `pane ${paneId}` : 'window'
        log(`tab closed by user; killing tmux ${target} in ${host} ${session}:${window.index} ${window.name}`)
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
      if (groupKey.startsWith(`${host}/`) && !groupKey.includes('\u0000') && !liveSessions.has(groupKey)) {
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
      const { repos } = await rpc(host, 'repo.list', {})
      const repoIds = new Set(repos.map((r) => r.id))
      for (const t of terminals ?? []) {
        const repoId = t.worktreeId.includes('::') ? t.worktreeId.split('::')[0] : null
        if (repoId && !repoIds.has(repoId) && /^Terminal \d+$/.test(t.title ?? '')) {
          await closeOwnTerminal(host, t.handle)
        }
      }
    }

    await publishPaneTitles(scan)
    // Views of gone windows/panes would otherwise fall through to a different window.
    const stale = [...scan.views.keys()].filter((v) => !liveViews.has(v))
    if (stale.length) {
      await remoteTmux(host, stale.map((v) => `tmux kill-session -t ${shq('=' + v)}`).join('; ')).catch(() => {})
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
      const out = await remoteTmux(host, `${script}; true`).catch(() => '')
      last = {
        at: Date.now(),
        changed: out
          .split('\n')
          .map((line) => line.split('\t'))
          .filter(([folder, path]) => folder && path)
          .map(([folder, path]) => ({ folder, path }))
      }
      nestedScans.set(host, last)
    }
    const changed = lane ? (last?.changed ?? []).filter((c) => folders.has(c.folder)) : []
    const wanted = new Map(changed.filter((c) => !windowRoots.has(c.path) && !nestedDismissed.has(`${host}/${c.path}`)).map((c) => [c.path, c]))

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
      const displayName = windows.length === 1 ? `${windows[0].window.index} ${windows[0].window.name}` : basename(rec.root)
      if (meta.displayName !== displayName) {
        updates.displayName = displayName
      }
      if (lastChange && meta.lastActivityAt !== lastChange) {
        updates.lastActivityAt = lastChange
      }
    }

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

  function tabUnits(host, window) {
    const key = `${host}/${window.id}`
    const agents = window.panes.filter((p) => p.agent)
    if (agents.length === 0) {
      return [{ key, view: unitViewName(window.id, null), paneId: null, title: windowTitle(window) }]
    }
    return agents.map((pane) => ({
      key: `${key}/${pane.id}`,
      view: unitViewName(window.id, pane.id),
      paneId: pane.id,
      title: [`${GLYPH[pane.state] ?? ''}${pane.agent} ${window.index}.${pane.index}`, idleAge(pane)].filter(Boolean).join(' · ')
    }))
  }

  function forgetUnit(unitKey) {
    for (const map of [everAttached, dismissed, pending, failures, suspects]) {
      map.delete(unitKey)
    }
  }

  // "+" in a window's card opens a new tmux window in the same folder; the "+" tab closes and the
  // new window gets its own card on the next pass.
  async function adoptPlusTabs(host, session, rec, handles) {
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
      if (!baselined.has(key) && !cardCreatedAt.has(key)) {
        continue // already there when this run started
      }
      const candidate = `${key}/${handle}`
      const firstSeen = plusCandidates.get(candidate)
      if (!firstSeen) {
        plusCandidates.set(candidate, Date.now())
        continue
      }
      if (Date.now() - firstSeen < SETTLE_MS) {
        continue
      }
      plusCandidates.delete(candidate)
      await newTmuxWindow(host, session, rec.folder).then(
        (id) => log(`new tab became tmux window ${host}/${id}`),
        (err) => log(`could not open a new window: ${err.message}`)
      )
      await closeOwnTerminal(host, handle)
    }
    baselined.add(key)
  }

  async function reconcileUnit(host, session, window, rec, unit, handles, runtimeId, vanished) {
    const { key } = unit
    const attached = currentScan?.views.get(unit.view)?.attached === true
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
        await rpc(host, 'terminal.rename', { terminal: tab.handle, title: unit.title }).then(
          () => (tab.title = unit.title),
          () => {}
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

  async function publishPaneTitles(scan) {
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
      await remoteTmux(scan.host, ['PATH=$PATH:/opt/homebrew/bin:/usr/local/bin', ...commands].join('; ')).catch(
        (err) => log(`set titles on ${scan.host} failed: ${err.message}`)
      )
    }
  }

  function trackAgentStates(host, sessionName, window) {
    for (const pane of window.panes) {
      const key = `${host}/${pane.id}`
      if (pane.agent) {
        const record = state.panes[key]
        if (record?.state !== pane.state) {
          state.panes[key] = { state: pane.state, since: Date.now() }
        }
        // The agent's own "done at" footer is a better idle start than when we first noticed.
        if (pane.state === 'idle' && pane.doneAt && pane.doneAt < state.panes[key].since) {
          state.panes[key].since = pane.doneAt
        }
        pane.since = state.panes[key].since
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
      if (loginWorkspace) {
        await rpc('local', 'folderWorkspace.delete', { folderWorkspaceId: loginWorkspace }).catch(() => {})
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
    const list = await cli.listEnvironments().catch(() => [])
    environments = new Map(
      list
        .filter((e) => targetName.has(e.orcadDeployment?.sshTargetId))
        .map((e) => [targetName.get(e.orcadDeployment.sshTargetId), e.id])
    )
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
    createdThisTick.clear()
    const hosts = resolveHosts(config, connected)
    const results = await Promise.all(
      hosts.map(async (host) => {
        if (loginTabs.has(host) && !(await settleLogin(host))) {
          return null // waiting for the password in the login tab
        }
        const backoff = hostBackoff.get(host)
        if (backoff && Date.now() < backoff.retryAt) {
          return null
        }
        try {
          const result = await scan(host, { env })
          hostBackoff.delete(host)
          return result
        } catch (err) {
          const failuresSoFar = (backoff?.failures ?? 0) + 1
          hostBackoff.set(host, {
            failures: failuresSoFar,
            retryAt: Date.now() + Math.min(30, 2 ** failuresSoFar) * 60_000
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
      })
    )
    if (!config.notify) {
      agentStates.clear()
    }
    for (const scan of results) {
      if (!scan) {
        continue
      }
      if (scan.host !== 'local' && !environments.has(scan.host)) {
        if (!warned.has(scan.host)) {
          warned.add(scan.host)
          log(`${scan.host}: no Orca server (orcad) for this host yet; connect it in Orca to mirror it`)
        }
        continue
      }
      currentScan = scan
      try {
        await reconcileHost(scan, runtimeId)
      } catch (err) {
        log(`sync ${scan.host} failed: ${err.message}`)
      }
    }
    currentScan = null
    saveState(state)
    return results.filter(Boolean)
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
    newWindow,
    reopenDismissed: () => {
      dismissed.clear()
      removedWindows.clear()
    },
    config: loadConfig
  }
}
