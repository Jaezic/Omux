// Inventory tmux sessions/windows/panes on one host and classify claude/codex panes.
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Grouped sessions this tool creates to show a window in an Orca tab: orca-w<window> for a window,
// orca-p<pane> for an agent pane's tab.
export const VIEW_PREFIX = 'orca-w'
export const PANE_VIEW_PREFIX = 'orca-p'
export const isViewSession = (name = '') => /^orca-[wp]\d+$/.test(name)
const SEP = '|#|'
const PANE_FIELDS = [
  'session_name',
  'window_id',
  'window_index',
  'window_name',
  'pane_id',
  'pane_index',
  'pane_active',
  'pane_pid',
  'pane_current_path',
  'pane_title'
]
const PANE_FMT = PANE_FIELDS.map((f) => `#{${f}}`).join(SEP)
const SESSION_FMT = ['session_name', 'session_attached', 'window_id'].map((f) => `#{${f}}`).join(SEP)

// One round trip per host: panes, sessions (for view coverage), process table.
const SCAN_SCRIPT = [
  'PATH=$PATH:/opt/homebrew/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin; export PATH',
  'echo "__HOME__$HOME"',
  `tmux list-panes -a -F '${PANE_FMT}' 2>/dev/null`,
  'echo __SESSIONS__',
  `tmux list-sessions -F '${SESSION_FMT}' 2>/dev/null`,
  'echo __PS__',
  'ps -eo pid=,ppid=,args= 2>/dev/null',
  'echo __CAP__',
  // Screen-scrape the bottom of each pane: claude keeps ✳ in its title even while working.
  `for p in $(tmux list-panes -a -F '#{pane_id}' 2>/dev/null | sort -u); do
    c=$(tmux capture-pane -p -J -t "$p" -S -15 2>/dev/null | tail -n 15)
    if printf '%s' "$c" | grep -qiE 'Do you want to|Would you like to|Allow command|requires approval|Press enter to confirm'; then echo "$p waiting"
    elif printf '%s' "$c" | grep -qE '… ?\\([0-9]|[Ee]sc to interrupt'; then echo "$p working"; fi
    d=$(tmux capture-pane -p -J -t "$p" -S -80 2>/dev/null | grep -oE '· done ((Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day )?[0-9]{1,2}:[0-9]{2}( ?[AP]M)?|[A-Z][a-z]{2} [0-9]{1,2} at [0-9]{1,2}:[0-9]{2} ?[AP]M' | tail -1)
    if [ -n "$d" ]; then echo "$p @done $d"; fi
    g=$(git -C "$(tmux display -p -t "$p" '#{pane_current_path}')" rev-parse --show-toplevel 2>/dev/null)
    if [ -n "$g" ]; then echo "$p @git $g"; fi
  done; true`
].join('; ')

export function controlPath() {
  return join(homedir(), '.orca-tmux', '.cm', '%C')
}

function run(cmd, args, { timeoutMs, env }) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr
        reject(err)
      } else {
        resolve(stdout)
      }
    })
  })
}

export async function scanHost(host, { env, timeoutMs = 10_000 } = {}) {
  const stdout =
    host === 'local'
      ? await run('/bin/sh', ['-c', SCAN_SCRIPT], { timeoutMs, env })
      : await run(
          'ssh',
          [
            '-o', 'BatchMode=yes',
            '-o', 'ConnectTimeout=5',
            '-o', 'ControlMaster=auto',
            '-o', `ControlPath=${controlPath()}`,
            '-o', 'ControlPersist=180',
            host,
            SCAN_SCRIPT
          ],
          { timeoutMs, env }
        )
  return parseScan(host, stdout)
}

export function parseScan(host, stdout) {
  const home = stdout.match(/^__HOME__(.*)$/m)?.[1] || null
  const [paneBlock = '', rest = ''] = stdout.replace(/^__HOME__.*\n/m, '').split('__SESSIONS__\n')
  const [sessionBlock = '', psRest = ''] = rest.split('__PS__\n')
  const [psBlock = '', capBlock = ''] = psRest.split('__CAP__\n')
  const procs = parsePs(psBlock)
  const screenStates = new Map()
  const doneStamps = new Map()
  const gitRoots = new Map()
  for (const line of capBlock.split('\n')) {
    const [id, kind, ...rest] = line.trim().split(' ')
    if (kind === '@done') {
      doneStamps.set(id, parseDoneStamp(rest.join(' ')))
    } else if (kind === '@git') {
      gitRoots.set(id, rest.join(' '))
    } else if (id && kind) {
      screenStates.set(id, kind)
    }
  }

  const views = new Map()
  for (const line of sessionBlock.split('\n')) {
    const [name, attached] = line.split(SEP)
    if (isViewSession(name)) {
      views.set(name, { attached: Number(attached) > 0 })
    }
  }

  const sessions = new Map()
  const seenPanes = new Set()
  // Sessions in a group share windows; each window belongs to the first session listing it.
  const windowOwner = new Map()
  for (const line of paneBlock.split('\n')) {
    const values = line.split(SEP)
    if (values.length !== PANE_FIELDS.length) {
      continue
    }
    const p = Object.fromEntries(PANE_FIELDS.map((f, i) => [f, values[i]]))
    // Grouped view sessions repeat the same windows; inventory only real sessions.
    if (isViewSession(p.session_name) || seenPanes.has(`${p.session_name}${p.pane_id}`)) {
      continue
    }
    if (windowOwner.has(p.window_id) && windowOwner.get(p.window_id) !== p.session_name) {
      continue
    }
    windowOwner.set(p.window_id, p.session_name)
    seenPanes.add(`${p.session_name}${p.pane_id}`)
    let session = sessions.get(p.session_name)
    if (!session) {
      session = { name: p.session_name, windows: new Map() }
      sessions.set(p.session_name, session)
    }
    let window = session.windows.get(p.window_id)
    if (!window) {
      window = { id: p.window_id, index: Number(p.window_index), name: p.window_name, panes: [] }
      session.windows.set(p.window_id, window)
    }
    const agent = detectAgent(Number(p.pane_pid), procs)
    if (p.pane_active === '1' || !window.path) {
      window.path = p.pane_current_path
      window.gitRoot = gitRoots.get(p.pane_id) ?? null // the repo holding the window's folder, if any
    }
    window.panes.push({
      id: p.pane_id,
      index: Number(p.pane_index),
      active: p.pane_active === '1',
      path: p.pane_current_path,
      title: p.pane_title,
      agent,
      state: agent ? (screenStates.get(p.pane_id) ?? 'idle') : null,
      doneAt: agent ? (doneStamps.get(p.pane_id) ?? null) : null
    })
  }

  return {
    host,
    home,
    views,
    sessions: [...sessions.values()].map((s) => ({
      name: s.name,
      windows: [...s.windows.values()].sort((a, b) => a.index - b.index)
    }))
  }
}

function parsePs(block) {
  const byPid = new Map()
  const children = new Map()
  for (const line of block.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (!m) {
      continue
    }
    const pid = Number(m[1])
    const ppid = Number(m[2])
    byPid.set(pid, m[3])
    if (!children.has(ppid)) {
      children.set(ppid, [])
    }
    children.get(ppid).push(pid)
  }
  return { byPid, children }
}

const base = (token = '') => token.split('/').pop()

export function classifyCommand(args) {
  const tokens = args.trim().split(/\s+/)
  const [first, second] = [base(tokens[0]), base(tokens[1])]
  const isNode = /^node(js)?$/.test(first) || first === 'bun'
  if (first === 'claude' || (isNode && (second === 'claude' || args.includes('@anthropic-ai/claude-code')))) {
    return 'claude'
  }
  if (first === 'codex' || (isNode && (second === 'codex' || args.includes('@openai/codex')))) {
    return 'codex'
  }
  return null
}

// Shallowest agent in the pane's process tree wins (an agent's own children don't count).
function detectAgent(rootPid, { byPid, children }) {
  const queue = [[rootPid, 0]]
  while (queue.length) {
    const [pid, depth] = queue.shift()
    const args = byPid.get(pid)
    const agent = args ? classifyCommand(args) : null
    if (agent) {
      return agent
    }
    if (depth < 6) {
      for (const child of children.get(pid) ?? []) {
        queue.push([child, depth + 1])
      }
    }
  }
  return null
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// When the agent last finished, from its own footer (local time; best effort):
//   claude "· done 1:51 PM" (today) / "· done Wednesday 1:51 PM" (this past week)
//   codex  "Oct 21 at 1:13 PM"
export function parseDoneStamp(text, now = new Date()) {
  const clock = text.match(/(\d{1,2}):(\d{2})\s*([AP]M)?/)
  if (!clock) {
    return null
  }
  let hours = Number(clock[1]) % 12
  if (clock[3] === 'PM' || (!clock[3] && Number(clock[1]) >= 12)) {
    hours += 12
  }
  const at = new Date(now)
  at.setHours(hours, Number(clock[2]), 0, 0)
  const month = MONTHS.findIndex((m) => text.startsWith(`${m} `))
  if (month >= 0) {
    at.setMonth(month, Number(text.split(' ')[1]))
    if (at > now) {
      at.setFullYear(at.getFullYear() - 1)
    }
    return at.getTime()
  }
  const weekday = WEEKDAYS.findIndex((d) => text.includes(d))
  if (weekday >= 0) {
    const back = (now.getDay() - weekday + 7) % 7 || 7
    at.setDate(at.getDate() - back)
  } else if (at > now) {
    at.setDate(at.getDate() - 1)
  }
  return at.getTime()
}
