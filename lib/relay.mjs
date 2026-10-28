// Runs tmux commands on SSH hosts over Orca's own connection (its orcad server there) instead of a
// second SSH connection. orcad can read and write files but not run commands, so a small helper
// on the host, started once in a tmux session, does the running:
//   ~/.orca-tmux/remote/scan.out       the scan, refreshed every few seconds
//   ~/.orca-tmux/remote/scan.stamp     "<time> <checksum>" of it: the runner fetches scan.out only
//                                      when the checksum changed (it is tens of KB)
//   ~/.orca-tmux/remote/cmd/<id>.sh    a command (ends with an END line); the helper writes <id>.out
//   ~/.orca-tmux/remote/trigger        touched by tmux hooks: scan now
//   ~/.orca-tmux/remote/changed        a counter, bumped after each scan a hook asked for (the runner
//                                      peeks at it between passes to fetch that scan at once)
//   ~/.orca-tmux/remote/alive          touched by the runner; the helper exits once it is 10 minutes stale
// Files are reached through a folder workspace on the host's home directory that Orca does not draw.
import { randomUUID } from 'node:crypto'
import { RELAY_SESSION, SCAN_SCRIPT, parseScan } from './scan.mjs'

const DIR = '.orca-tmux/remote'
const GROUP_NAME = 'Omux relay'
const LAST = 1_000_000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

// A command file is complete once its last line is END: orcad writes it in one call, but the helper
// may look while the write is in progress.
const END = '#__omux_end__'

export function helperScript(intervalSec = 5) {
  const ticks = Math.max(5, Math.round(intervalSec * 5))
  return `D="$HOME/${DIR}"
umask 077
mkdir -p "$D/cmd"
n=0; k=0; t=0
T=""; command -v timeout >/dev/null 2>&1 && T="timeout 15"
while :; do
  if [ -n "$(find "$D/alive" -mmin +10 2>/dev/null)" ] || [ ! -f "$D/alive" ]; then exit 0; fi
  for f in "$D"/cmd/*.sh; do
    [ -e "$f" ] || break
    [ "$(tail -n 1 "$f")" = "${END}" ] || continue
    b="\${f%.sh}"; $T sh "$f" > "$b.tmp" 2>&1; echo "__RC__$?" >> "$b.tmp"; mv "$b.tmp" "$b.out"; rm -f "$f"
  done
  if [ -e "$D/trigger" ]; then rm -f "$D/trigger"; n=0; t=1; fi
  if [ "$n" -le 0 ]; then
    sh "$D/scan.sh" > "$D/scan.tmp" 2>/dev/null; c=$(cksum < "$D/scan.tmp" | cut -d' ' -f1); a=$(date +%s)
    printf '__SUM__%s\n__AT__%s\n' "$c" "$a" >> "$D/scan.tmp"; mv "$D/scan.tmp" "$D/scan.out"; n=${ticks}
    echo "$a $c" > "$D/stamp.tmp"; mv "$D/stamp.tmp" "$D/scan.stamp"
    if [ "$t" = 1 ]; then k=$((k + 1)); t=0; echo "$k" > "$D/changed.tmp"; mv "$D/changed.tmp" "$D/changed"; fi
    find "$D/cmd" -name '*.out' -mmin +2 -exec rm -f {} + 2>/dev/null
  fi
  n=$((n - 1)); sleep 0.2
done
`
}

export function createRelay({ rpc, state, log = () => {}, intervalSec = () => 5 }) {
  const hosts = new Map() // host -> { home, fw, lastAt, lastAtSeen, startedAt }

  const file = (host, name) => ({ worktree: `folder:${hosts.get(host).fw}`, relativePath: `${DIR}/${name}` })
  const write = (host, name, content) =>
    rpc(host, 'files.write', { ...file(host, name), content, expectedExecutionHostId: 'local' })

  async function read(host, name) {
    const first = await rpc(host, 'files.read', file(host, name))
    if (!first.truncated) {
      return first.content
    }
    let content = ''
    for (let offset = 0; ; offset += 512 * 1024) {
      const chunk = await rpc(host, 'files.readChunk', { ...file(host, name), offset, length: 512 * 1024 })
      content += chunk.content ?? ''
      if (!chunk.content || chunk.content.length < 512 * 1024) {
        return content
      }
    }
  }

  // The workspace the files are reached through sits in a group of its own without a parent folder:
  // Orca draws no card for a folder workspace in such a group (archiving does not hide folder
  // workspaces). The group is kept collapsed at the bottom of the project list.
  async function controlWorkspace(host) {
    const known = hosts.get(host)
    if (known?.fw) {
      return known
    }
    const { resolvedPath: home } = await rpc(host, 'files.browseServerDir', { path: '~' })
    const saved = state.relay?.[host]
    const [{ folderWorkspaces }, { groups }] = await Promise.all([
      rpc(host, 'folderWorkspace.list', {}),
      rpc(host, 'projectGroup.list', null)
    ])
    let group = groups.find((g) => g.id === saved?.group && !g.parentPath && g.name === GROUP_NAME)
    let ws = group && folderWorkspaces.find((w) => w.id === saved?.fw && w.folderPath === home && w.projectGroupId === group.id)
    if (!ws && saved?.fw && folderWorkspaces.some((w) => w.id === saved.fw)) {
      // An earlier layout parked it in a session group, where it showed as a card.
      await rpc(host, 'folderWorkspace.delete', { folderWorkspaceId: saved.fw }).catch(() => {})
    }
    if (!group) {
      group = (await rpc(host, 'projectGroup.create', { name: GROUP_NAME })).group
    }
    if (!ws) {
      ws = (await rpc(host, 'folderWorkspace.create', { projectGroupId: group.id, name: 'omux relay', folderPath: home })).folderWorkspace
    }
    if (!group.isCollapsed || group.tabOrder !== LAST) {
      await rpc(host, 'projectGroup.update', { groupId: group.id, updates: { isCollapsed: true, tabOrder: LAST } }).catch(() => {})
    }
    state.relay = { ...state.relay, [host]: { group: group.id, fw: ws.id } }
    for (const dir of ['.orca-tmux', DIR, `${DIR}/cmd`]) {
      await rpc(host, 'files.createDir', { worktree: `folder:${ws.id}`, relativePath: dir, expectedExecutionHostId: 'local' }).catch(() => {})
    }
    // Found anew after an error: what was seen of the helper still counts, so a stuck helper is noticed.
    const entry = Object.assign(hosts.get(host) ?? { lastAt: null, lastAtSeen: 0, startedAt: 0 }, { home, fw: ws.id })
    hosts.set(host, entry)
    return entry
  }

  // Writes the helper and starts it in its own tmux session through a terminal in the hidden
  // workspace (orcad runs it on the host); the terminal is closed once the session is up.
  async function startHelper(host) {
    const entry = hosts.get(host)
    if (Date.now() - entry.startedAt < 60_000) {
      return
    }
    entry.startedAt = Date.now()
    await write(host, 'alive', `${Date.now()}\n`)
    await write(host, 'scan.sh', `${SCAN_SCRIPT}\n`)
    await write(host, 'helper.sh', helperScript(intervalSec()))
    const helper = `${entry.home}/${DIR}/helper.sh`
    const command = `PATH=$PATH:/opt/homebrew/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin; tmux kill-session -t ${RELAY_SESSION} 2>/dev/null; tmux new-session -d -s ${RELAY_SESSION} ${shq(`sh ${shq(helper)}`)}; exit`
    const { terminal } = await rpc(host, 'terminal.create', {
      worktree: `folder:${entry.fw}`,
      command,
      title: 'omux relay',
      presentation: 'background'
    })
    log(`${host}: started the relay helper over Orca's connection`)
    setTimeout(() => {
      rpc(host, 'terminal.closeTab', { terminal: terminal.handle }).catch(() =>
        rpc(host, 'terminal.close', { terminal: terminal.handle }).catch(() => {})
      )
    }, 8_000)
  }

  // A failed call may mean the workspace is gone (its session group was removed): find it anew.
  const forgetOnError = (host) => (err) => {
    if (!err.relayStarting && !/^exit \d+/.test(err.message) && hosts.has(host)) {
      hosts.get(host).fw = null
    }
    throw err
  }

  function scan(host) {
    return scanOnce(host).catch(forgetOnError(host))
  }

  function exec(host, script, timeoutMs) {
    return execOnce(host, script, timeoutMs).catch(forgetOnError(host))
  }

  async function scanOnce(host) {
    const entry = await controlWorkspace(host)
    if (Date.now() - (entry.aliveAt ?? 0) > 60_000) {
      await write(host, 'alive', `${Date.now()}\n`)
      entry.aliveAt = Date.now()
    }
    // Unchanged since the last fetch (same checksum): reuse it, with the stamp's time.
    const stamp = (await read(host, 'scan.stamp').catch(() => null))?.match(/^(\d+) (\d+)/)
    let out
    if (stamp && entry.scan?.sum === stamp[2]) {
      out = entry.scan.text.replace(/^__AT__\d+\s*$/m, `__AT__${stamp[1]}`)
    } else {
      out = await read(host, 'scan.out').catch(() => null)
      const sum = out?.match(/^__SUM__(\d+)\s*$/m)?.[1]
      entry.scan = sum ? { sum, text: out } : null
    }
    // Once per run: a helper from an older version of this tool is replaced.
    if (!entry.checked) {
      entry.checked = true
      const current = await read(host, 'helper.sh').catch(() => null)
      const scanScript = await read(host, 'scan.sh').catch(() => null)
      if (current !== null && (current !== helperScript(intervalSec()) || scanScript !== `${SCAN_SCRIPT}\n`)) {
        await startHelper(host)
        throw Object.assign(new Error('relay helper updating'), { relayStarting: true })
      }
    }
    const at = out?.match(/^__AT__(\d+)\s*$/m)?.[1] ?? null
    if (at !== entry.lastAt) {
      entry.lastAt = at
      entry.lastAtSeen = Date.now()
    }
    // No scan yet, or none newer for a while: the helper is not running (host rebooted, first use).
    if (!at || Date.now() - entry.lastAtSeen > Math.max(30_000, intervalSec() * 6_000)) {
      await startHelper(host)
      throw Object.assign(new Error('relay helper starting'), { relayStarting: true })
    }
    return parseScan(host, out.replace(/^__AT__.*$/m, '').replace(/^__SUM__.*$/m, ''))
  }

  async function execOnce(host, script, timeoutMs = 20_000) {
    await controlWorkspace(host)
    const id = randomUUID()
    await write(host, `cmd/${id}.sh`, `${script}\n${END}\n`)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await sleep(150)
      const out = await read(host, `cmd/${id}.out`).catch(() => null)
      if (out === null) {
        continue
      }
      // Not waited for: the helper also sweeps results older than two minutes.
      rpc(host, 'files.delete', { ...file(host, `cmd/${id}.out`), expectedExecutionHostId: 'local' }).catch(() => {})
      const rc = Number(out.match(/__RC__(\d+)\s*$/)?.[1] ?? 0)
      const output = out.replace(/__RC__\d+\s*$/, '')
      if (rc !== 0) {
        throw Object.assign(new Error(`exit ${rc}: ${output.trim().split('\n').pop() ?? ''}`), { stdout: output })
      }
      return output
    }
    // Commands are cut off after 15s on the host (where timeout(1) exists). No answer and no fresh
    // scan either: the helper is stuck or gone, so start it again (at most once a minute). A helper
    // still scanning is only busy with a queue and is left alone.
    const entry = hosts.get(host)
    if (!entry || Date.now() - entry.lastAtSeen > Math.max(10_000, intervalSec() * 3_000)) {
      await startHelper(host).catch(() => {})
    }
    throw new Error('relay command timed out')
  }

  // Between passes: the "changed" counter, if the helper is known (never sets anything up). Changes
  // when a hook-triggered scan is ready.
  async function peek(host) {
    if (!hosts.get(host)?.fw) {
      return null
    }
    return read(host, 'changed').catch(() => null)
  }

  return { scan, exec, peek, forget: (host) => hosts.delete(host) }
}
