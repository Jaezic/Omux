// Local tmux survives a reboot as a snapshot: sessions, windows (name, index, layout), panes
// (folder) and the conversation of each agent pane are saved now and then. After a reboot the
// runner finds tmux empty and rebuilds it from the snapshot: shells open in their folders and agent
// panes get `claude --resume <id>` / `codex resume <id>` typed, not run (restore: false turns it
// off; restoreAgents: "run" presses enter too, false leaves agent panes as plain shells).
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { RELAY_SESSION, classifyCommand, isViewSession, resumeArgs } from './scan.mjs'

const SEP = '\x1f'
const FIELDS = ['session_name', 'window_id', 'pane_id', 'window_index', 'window_name', 'window_layout', 'window_active', 'automatic-rename', 'pane_index', 'pane_active', 'pane_pid', 'pane_current_path']

const run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  )

const skipped = (name) => isViewSession(name) || name === RELAY_SESSION || name.startsWith('orca-')

// The conversation an agent process is in, so it can be resumed. Claude writes its session id to
// ~/.claude/sessions/<pid>.json; codex keeps its rollout file open. Without either, what its own
// command line says (--resume <id>), else the latest conversation in that folder.
export async function agentResume(kind, pid, args, { home = homedir(), exec = run } = {}) {
  if (kind === 'claude') {
    try {
      const id = JSON.parse(readFileSync(join(home, '.claude', 'sessions', `${pid}.json`), 'utf8')).sessionId
      if (/^[0-9a-f-]{16,}$/i.test(id ?? '')) {
        return `--resume ${id}`
      }
    } catch {}
    return resumeArgs('claude', args) || '--continue'
  }
  try {
    const open = await exec('lsof', ['-p', String(pid), '-Fn'])
    const id = open.match(/\.codex\/sessions\/\S*rollout-\S*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl/i)?.[1]
    if (id) {
      return `resume ${id}`
    }
  } catch {}
  return resumeArgs('codex', args) || 'resume --last'
}

// The agent in a pane: the shallowest claude/codex process under the pane's shell.
function paneAgent(rootPid, procs) {
  const queue = [rootPid]
  while (queue.length) {
    const pid = queue.shift()
    const proc = procs.get(pid)
    const kind = proc && pid !== rootPid ? classifyCommand(proc.args) : null
    if (kind) {
      return { kind, pid, args: proc.args }
    }
    for (const [child, p] of procs) {
      if (p.ppid === pid) {
        queue.push(child)
      }
    }
  }
  return null
}

export function parsePanes(stdout) {
  const sessions = new Map()
  for (const line of stdout.split('\n').filter(Boolean)) {
    const v = Object.fromEntries(line.split(SEP).map((x, i) => [FIELDS[i], x]))
    if (skipped(v.session_name)) {
      continue
    }
    const session = sessions.get(v.session_name) ?? { name: v.session_name, windows: [] }
    sessions.set(v.session_name, session)
    let window = session.windows.find((w) => w.index === Number(v.window_index))
    if (!window) {
      window = { id: v.window_id, index: Number(v.window_index), name: v.window_name, autoName: v['automatic-rename'] === '1', layout: v.window_layout, active: v.window_active === '1', panes: [] }
      session.windows.push(window)
    }
    window.panes.push({ id: v.pane_id, index: Number(v.pane_index), active: v.pane_active === '1', pid: Number(v.pane_pid), path: v.pane_current_path })
  }
  for (const session of sessions.values()) {
    session.windows.sort((a, b) => a.index - b.index)
    session.windows.forEach((w) => w.panes.sort((a, b) => a.index - b.index))
  }
  return [...sessions.values()]
}

export async function takeSnapshot(file, { exec = run, home = homedir() } = {}) {
  let sessions
  try {
    sessions = parsePanes(await exec('tmux', ['list-panes', '-a', '-F', FIELDS.map((f) => `#{${f}}`).join(SEP)]))
  } catch {
    return null // no tmux server
  }
  if (!sessions.length) {
    return null // never overwrite a good snapshot with an empty tmux
  }
  const procs = new Map()
  for (const line of (await exec('ps', ['-Ao', 'pid=,ppid=,args=']).catch(() => '')).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (m) {
      procs.set(Number(m[1]), { ppid: Number(m[2]), args: m[3] })
    }
  }
  for (const pane of sessions.flatMap((s) => s.windows.flatMap((w) => w.panes))) {
    const agent = paneAgent(pane.pid, procs)
    if (agent) {
      pane.agent = agent.kind
      pane.resume = await agentResume(agent.kind, agent.pid, agent.args, { home, exec })
    }
    delete pane.pid
  }
  const snapshot = { at: Date.now(), sessions }
  writeFileSync(`${file}.tmp`, JSON.stringify(snapshot, null, 2))
  renameSync(`${file}.tmp`, file)
  return snapshot
}

export async function bootTime({ exec = run } = {}) {
  const out = await exec('sysctl', ['-n', 'kern.boottime']).catch(() => '')
  const sec = out.match(/sec\s*=\s*(\d+)/)?.[1]
  return sec ? Number(sec) * 1000 : null
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

// Rebuilds tmux from the snapshot when the computer rebooted since it was taken and tmux has no
// sessions of its own yet. Returns the old -> new window and pane ids ({ "@3": "@0", "%7": "%1" }),
// or null when nothing was done.
export async function restoreIfRebooted(file, { exec = run, log = () => {}, config = {}, home = homedir() } = {}) {
  if (config.restore === false || !existsSync(file)) {
    return null
  }
  let snapshot
  try {
    snapshot = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  const booted = await bootTime({ exec })
  if (!booted || !(snapshot.at < booted) || !snapshot.sessions?.length) {
    return null
  }
  const existing = await exec('tmux', ['list-sessions', '-F', '#{session_name}']).catch(() => '')
  if (existing.split('\n').some((name) => name && !skipped(name))) {
    return null // tmux already has sessions: someone started over by hand
  }
  const agents = config.restoreAgents ?? 'type'
  const folder = (path) => (path && existsSync(path) ? path : home)
  let restored = 0
  const ids = {}
  for (const session of snapshot.sessions) {
    try {
      const target = `=${session.name}`
      let first = true
      for (const window of session.windows) {
        const [p0, ...rest] = window.panes
        const out = first
          ? await exec('tmux', ['new-session', '-d', '-s', session.name, '-n', window.name, '-c', folder(p0.path), '-P', '-F', `#{window_id}${SEP}#{pane_id}`])
          : await exec('tmux', ['new-window', '-d', '-t', `${target}:${window.index}`, '-n', window.name, '-c', folder(p0.path), '-P', '-F', `#{window_id}${SEP}#{pane_id}`])
        const [windowId, paneId] = out.trim().split(SEP)
        ids[window.id] = windowId
        if (first) {
          await exec('tmux', ['move-window', '-s', windowId, '-t', `${target}:${window.index}`]).catch(() => {})
          first = false
        }
        const paneIds = [paneId]
        for (const pane of rest) {
          paneIds.push((await exec('tmux', ['split-window', '-d', '-t', windowId, '-c', folder(pane.path), '-P', '-F', '#{pane_id}'])).trim())
        }
        window.panes.forEach((pane, i) => (ids[pane.id] = paneIds[i]))
        if (window.panes.length > 1) {
          await exec('tmux', ['select-layout', '-t', windowId, window.layout]).catch(() => {})
        }
        if (window.autoName) {
          await exec('tmux', ['set-option', '-w', '-t', windowId, 'automatic-rename', 'on']).catch(() => {})
        }
        for (const [i, pane] of window.panes.entries()) {
          if (pane.agent && agents) {
            await exec('tmux', ['send-keys', '-t', paneIds[i], '-l', `${pane.agent} ${pane.resume ?? ''}`.trim()])
            if (agents === 'run') {
              await exec('tmux', ['send-keys', '-t', paneIds[i], 'Enter'])
            }
          }
          if (pane.active) {
            await exec('tmux', ['select-pane', '-t', paneIds[i]]).catch(() => {})
          }
        }
        if (window.active) {
          await exec('tmux', ['select-window', '-t', windowId]).catch(() => {})
        }
        restored++
      }
    } catch (err) {
      log(`restore of session ${shq(session.name)} stopped: ${err.message}`)
    }
  }
  log(`restored ${restored} tmux windows from before the reboot`)
  return restored ? ids : null
}
