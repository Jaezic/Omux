// Inventory tmux sessions/windows/panes on one host and classify claude/codex panes.
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Grouped sessions this tool creates to show a window in an Orca tab: orca-w<window> for a window,
// orca-p<pane> for an agent pane's tab.
export const VIEW_PREFIX = 'orca-w'
export const PANE_VIEW_PREFIX = 'orca-p'
export const isViewSession = (name = '') => /^orca-[wp]\d+$/.test(name)
// The tmux session running the relay helper on hosts reached through Orca (lib/relay.mjs).
export const RELAY_SESSION = 'omux-relay'
const SEP = '|#|'
const SEP_RE = "[|]#[|]"
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
  'automatic-rename',
  'host_short',
  'session_id',
  'pane_title'
]
const PANE_FMT = PANE_FIELDS.map((f) => `#{${f}}`).join(SEP)
const SESSION_FMT = ['session_name', 'session_attached', 'window_id'].map((f) => `#{${f}}`).join(SEP)

// One round trip per host: panes, sessions (for view coverage), process table.
// Reads the captured screens of all agent panes in one pass ("@@PANE %N" before each) and prints
// "%N waiting|working", "%N @ask <what>", "%N @done <stamp>". Only the last 15 non-blank lines
// count for the state. What a waiting agent asks: codex prints the command as "$ cmd", claude
// between ╌ rules; otherwise the question itself ("Do you want to make this edit to x.ts?").
// Plain POSIX awk (BSD awk, mawk): no IGNORECASE, no {n,m}.
export const STATE_AWK = String.raw`
function flush(   n, i, l, t, low, waiting, working, a, b, q, d, inrule, start) {
  if (pane == "") return
  n = 0
  for (i = 1; i <= cnt; i++) if (line[i] !~ /^[ \t]*$/) nb[++n] = line[i]
  start = n > 15 ? n - 14 : 1
  for (i = start; i <= n; i++) {
    l = nb[i]; low = tolower(l)
    if (low ~ /do you want to|would you like to|allow command|requires approval|press enter to confirm/) waiting = 1
    if (l ~ /… ?\([0-9]|[Ee]sc to interrupt/) working = 1
    t = l; sub(/^[ \t│]+/, "", t); sub(/[ \t│]+$/, "", t)
    if (t ~ /^\$ /) a = substr(t, 3)
    if (index(t, "╌") == 1) { inrule = !inrule; continue }
    if (inrule && t != "" && b == "") b = t
    if (t ~ /Do you want to|Would you like to/) q = t
  }
  if (waiting) {
    print pane " waiting"
    t = a != "" ? a : (b != "" ? b : q)
    if (t != "") print pane " @ask " substr(t, 1, 120)
  } else if (working) print pane " working"
  for (i = 1; i <= cnt; i++)
    if (match(line[i], /· done ((Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day )?[0-9][0-9]?:[0-9][0-9]( ?[AP]M)?|[A-Z][a-z][a-z] [0-9][0-9]? at [0-9][0-9]?:[0-9][0-9] ?[AP]M/))
      d = substr(line[i], RSTART, RLENGTH)
  if (d != "") print pane " @done " d
  # The last answer of the agent: claude "⏺ text", codex "• text", with the indented continuation
  # lines; tool calls ("⏺ Bash(…)", "• Ran …") are not answers. For claude, the answer before the
  # last "· done" footer. (No apostrophes here: this program sits in single quotes.)
  msg = ""; final = ""; inblk = 0
  for (i = 1; i <= cnt; i++) {
    l = line[i]
    if (l ~ /^(⏺|•) /) {
      t = substr(l, index(l, " ") + 1)
      inblk = !(t ~ /^[A-Z][A-Za-z]+\(/ || t ~ /^(Called|Failed|Ran|Running|Explored|Edited|Read|Searched|Updated Plan|Waited|Working|Stopped watching|Interrupted)( |$)/)
      if (inblk) msg = t
      continue
    }
    if (inblk && l ~ /^  [^ ⎿]/) { t = l; sub(/^ +/, "", t); msg = msg " " t; continue }
    if (l ~ /· done /) final = msg
    inblk = 0
  }
  if (final != "") msg = final
  if (msg != "") print pane " @msg " substr(msg, 1, 400)
}
/^@@PANE / { flush(); pane = $2; cnt = 0; delete nb; next }
{ line[++cnt] = $0 }
END { flush() }
`

// Agent processes, as a superset of classifyCommand: only their panes get their screens read.
const AGENT_RE = String.raw`(^|[ /])(claude|codex)( |$)|@anthropic-ai/claude-code|@openai/codex|codex\.js`

export const SCAN_SCRIPT = [
  'PATH=$PATH:/opt/homebrew/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin; export PATH',
  'O="$HOME/.orca-tmux"; mkdir -p "$O"',
  'echo "__HOME__$HOME"',
  // One pane listing for everything below (pane ids, pids and folders are fields 5, 8 and 9).
  `L=$(tmux list-panes -a -F '${PANE_FMT}' 2>/dev/null)`,
  `printf '%s\\n' "$L"`,
  'echo __SESSIONS__',
  `tmux list-sessions -F '${SESSION_FMT}' 2>/dev/null`,
  'echo __PS__',
  'P=$(ps -eo pid=,ppid=,args= 2>/dev/null)',
  // Only the processes in the panes' trees (six levels down, as deep as the agent search goes):
  // the whole table is hundreds of KB, read through Orca every few seconds on SSH hosts.
  `{ printf '%s\\n' "$L" | awk -F'${SEP_RE}' '{ print "@pane " $8 }'; printf '%s\\n' "$P"; } | awk '
    $1 == "@pane" { root[$2] = 1; next }
    { line[$1] = $0; kids[$2] = kids[$2] " " $1 }
    END { n = 0; for (r in root) { q[++n] = r; d[r] = 0 }
      for (i = 1; i <= n; i++) { p = q[i]; if (p in line) print line[p]
        if (d[p] < 6) { m = split(kids[p], k, " "); for (j = 1; j <= m; j++) if (!(k[j] in d)) { d[k[j]] = d[p] + 1; q[++n] = k[j] } } } }'`,
  'echo __CAP__',
  // The terminal each view client writes to (Orca's tab): in-band status for Orca goes there.
  "tmux list-clients -F '@client #{session_name} #{client_tty}' 2>/dev/null",
  // Panes with an agent process somewhere below them.
  `A=$( { printf '%s\\n' "$L" | awk -F'${SEP_RE}' '{ print "@pane " $5 " " $8 }'; printf '%s\\n' "$P"; } | awk -v re='${AGENT_RE}' '
    $1 == "@pane" { pane[$3] = $2; next }
    { pid = $1; par[pid] = $2; $1 = ""; $2 = ""; if ($0 ~ re) agent[pid] = 1 }
    END { for (a in agent) { q = a; for (i = 0; i < 40 && q > 1; i++) { if (q in pane) { print pane[q]; break } q = par[q] } } }' | sort -u)`,
  // Screen-scrape the bottom of each agent pane: claude keeps ✳ in its title even while working.
  // All in one tmux call; if a pane went away meanwhile (tmux stops the chain there), pane by pane.
  `set --; for p in $A; do set -- "$@" display-message -p "@@PANE $p" \\; capture-pane -p -J -t "$p" -S -80 \\;; done`,
  `{ [ $# -eq 0 ] || tmux "$@" 2>/dev/null || for p in $A; do echo "@@PANE $p"; tmux capture-pane -p -J -t "$p" -S -80 2>/dev/null; done; } | awk '${STATE_AWK}'`,
  // Each folder's git repo, cached for 5 minutes: git runs only for folders not seen lately.
  'G="$O/gitroots"; if [ -n "$(find "$G" -mmin +5 2>/dev/null)" ]; then rm -f "$G"; fi; touch "$G"',
  `printf '%s\\n' "$L" | awk -F'${SEP_RE}' 'NF >= 9 { print $5 "\\t" $9 }' | sort -u > "$O/panes.tsv"`,
  `awk -F'\\t' 'FILENAME == ARGV[1] { c[$1] = 1; next } !($2 in c) { print $2 }' "$G" "$O/panes.tsv" | sort -u | while IFS= read -r d; do
    printf '%s\\t%s\\n' "$d" "$(git -C "$d" rev-parse --show-toplevel 2>/dev/null)" >> "$G"
  done`,
  `awk -F'\\t' 'FILENAME == ARGV[1] { r[$1] = $2; next } r[$2] != "" { print $1 " @git " r[$2] }' "$G" "$O/panes.tsv"; true`
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
  const asks = new Map()
  const clientTtys = new Map()
  const messages = new Map()
  for (const line of capBlock.split('\n')) {
    const [id, kind, ...rest] = line.trim().split(' ')
    if (kind === '@msg') {
      // Plain text for a notification: no markdown emphasis or code ticks, no cut-off last character.
      messages.set(id, rest.join(' ').replace(/\*\*|`/g, '').replace(/\uFFFD+$/, ''))
    } else if (id === '@client') {
      clientTtys.set(kind, rest[0])
    } else if (kind === '@ask') {
      asks.set(id, rest.join(' '))
    } else if (kind === '@done') {
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
      views.set(name, { attached: Number(attached) > 0, tty: clientTtys.get(name) ?? null })
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
    if (isViewSession(p.session_name) || p.session_name === RELAY_SESSION || seenPanes.has(`${p.session_name}${p.pane_id}`)) {
      continue
    }
    if (windowOwner.has(p.window_id) && windowOwner.get(p.window_id) !== p.session_name) {
      continue
    }
    windowOwner.set(p.window_id, p.session_name)
    seenPanes.add(`${p.session_name}${p.pane_id}`)
    let session = sessions.get(p.session_name)
    if (!session) {
      session = { name: p.session_name, id: p.session_id, windows: new Map() }
      sessions.set(p.session_name, session)
    }
    let window = session.windows.get(p.window_id)
    if (!window) {
      // autoName: tmux names it after the running command (nobody named it), e.g. "2.1.311" for claude.
      window = { id: p.window_id, index: Number(p.window_index), name: p.window_name, autoName: p['automatic-rename'] === '1', panes: [] }
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
      hostShort: p.host_short, // tmux's default pane title: not a task
      agent,
      state: agent ? (screenStates.get(p.pane_id) ?? 'idle') : null,
      doneAt: agent ? (doneStamps.get(p.pane_id) ?? null) : null,
      ask: agent && screenStates.get(p.pane_id) === 'waiting' ? (asks.get(p.pane_id) ?? null) : null,
      message: agent ? (messages.get(p.pane_id) ?? null) : null // its last answer
    })
  }

  return {
    host,
    home,
    views,
    sessions: [...sessions.values()].map((s) => ({
      name: s.name,
      id: s.id, // kept across renames
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

// Seconds from ps's etime ([[dd-]hh:]mm:ss).
function elapsedSeconds(etime) {
  const [days, clock] = etime.includes('-') ? etime.split('-') : ['0', etime]
  return clock.split(':').reduce((sum, part) => sum * 60 + Number(part), 0) + Number(days) * 86_400
}

// The command line of the newest `kind` agent running in an Orca terminal (under Orca's terminal
// host, or orcad on an SSH host), from `ps -eo pid=,ppid=,etime=,args=` output.
export function findOrcaAgentArgs(psOutput, kind, maxAgeSec = 300) {
  const procs = new Map()
  for (const line of psOutput.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
    if (m) {
      procs.set(Number(m[1]), { ppid: Number(m[2]), age: elapsedSeconds(m[3]), args: m[4] })
    }
  }
  const underOrca = (pid) => {
    for (let p = procs.get(pid), hops = 0; p && hops < 20; p = procs.get(p.ppid), hops++) {
      if (/Orca Terminal Host|orcad/.test(p.args)) {
        return true
      }
      if (/(^|\/)tmux/.test(p.args)) {
        return false
      }
    }
    return false
  }
  const found = [...procs.entries()]
    .filter(([pid, p]) => p.age <= maxAgeSec && classifyCommand(p.args) === kind && underOrca(pid))
    .sort((a, b) => a[1].age - b[1].age)
  return found[0]?.[1].args ?? null
}

// The resume part of an agent command line ("--resume <id>", "resume --last", ...), so the same
// conversation continues when the agent is restarted elsewhere. Prompts are left out: ps loses
// their quoting.
export function resumeArgs(kind, args) {
  if (!args) {
    return ''
  }
  const id = '([0-9A-Za-z][0-9A-Za-z_-]{7,})'
  if (kind === 'claude') {
    const resume = args.match(new RegExp(`(?:^|\\s)(?:--resume|-r)(?:\\s+|=)${id}`))
    if (resume) {
      return `--resume ${resume[1]}`
    }
    return /(?:^|\s)(?:--continue|-c)(?:\s|$)/.test(args) ? '--continue' : ''
  }
  const resume = args.match(new RegExp(`(?:^|\\s)(resume|fork)\\s+(?:${id}|(--last))`))
  return resume ? `${resume[1]} ${resume[2] ?? resume[3]}` : ''
}
