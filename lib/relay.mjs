// Runs tmux commands on SSH hosts over Orca's own connection (its orcad server there) instead of a
// second SSH connection. orcad can read and write files but not run commands, so a small helper
// on the host, started once in a tmux session, does the running:
//   ~/.orca-tmux/remote/scan.out       the scan, refreshed every few seconds
//   ~/.orca-tmux/remote/cmd/<id>.sh    a command; the helper writes <id>.out (output + exit code)
//   ~/.orca-tmux/remote/alive          touched by the runner; the helper exits once it is 10 minutes stale
// Files are reached through a hidden folder workspace on the host's home directory.
import { randomUUID } from 'node:crypto'
import { RELAY_SESSION, SCAN_SCRIPT, parseScan } from './scan.mjs'

const DIR = '.orca-tmux/remote'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

export function helperScript(intervalSec = 5) {
  const ticks = Math.max(2, Math.round(intervalSec * 2))
  return `D="$HOME/${DIR}"
umask 077
mkdir -p "$D/cmd"
n=0
while :; do
  if [ -n "$(find "$D/alive" -mmin +10 2>/dev/null)" ] || [ ! -f "$D/alive" ]; then exit 0; fi
  for f in "$D"/cmd/*.sh; do
    [ -e "$f" ] || break
    b="\${f%.sh}"; sh "$f" > "$b.tmp" 2>&1; echo "__RC__$?" >> "$b.tmp"; mv "$b.tmp" "$b.out"; rm -f "$f"
  done
  if [ "$n" -le 0 ]; then
    sh "$D/scan.sh" > "$D/scan.tmp" 2>/dev/null; echo "__AT__$(date +%s)" >> "$D/scan.tmp"; mv "$D/scan.tmp" "$D/scan.out"; n=${ticks}
  fi
  n=$((n - 1)); sleep 0.5
done
`
}

export function createRelay({ rpc, state, log = () => {}, intervalSec = () => 5, hostGroup = () => null }) {
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

  // The workspace the files are reached through: archived (hidden from the sidebar) and parked in
  // one of the host's session groups. Only a host with no session yet gets a group of its own,
  // moved into a session group once one exists.
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
    const sessionGroup = hostGroup(host, groups)
    const own = saved?.own ?? groups.find((g) => g.id === saved?.group)?.name === 'Omux relay'
    let ws = folderWorkspaces.find((w) => w.id === saved?.fw && w.folderPath === home)
    let group = saved?.group
    if (ws && own && sessionGroup) {
      await rpc(host, 'folderWorkspace.delete', { folderWorkspaceId: ws.id }).catch(() => {})
      await rpc(host, 'projectGroup.delete', { groupId: group }).catch(() => {})
      ws = null
    }
    if (!ws) {
      group = sessionGroup ?? (own && groups.some((g) => g.id === saved?.group) ? saved.group : null)
      if (!group) {
        group = (await rpc(host, 'projectGroup.create', { name: 'Omux relay' })).group.id
      }
      ws = (await rpc(host, 'folderWorkspace.create', { projectGroupId: group, name: 'omux relay', folderPath: home })).folderWorkspace
    }
    if (!ws.isArchived) {
      await rpc(host, 'folderWorkspace.update', { folderWorkspaceId: ws.id, updates: { isArchived: true } }).catch(() => {})
    }
    state.relay = { ...state.relay, [host]: { group, fw: ws.id, own: group !== sessionGroup } }
    for (const dir of ['.orca-tmux', DIR, `${DIR}/cmd`]) {
      await rpc(host, 'files.createDir', { worktree: `folder:${ws.id}`, relativePath: dir, expectedExecutionHostId: 'local' }).catch(() => {})
    }
    const entry = { home, fw: ws.id, lastAt: null, lastAtSeen: 0, startedAt: 0 }
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
    if (!err.relayStarting && !/^exit \d+/.test(err.message)) {
      hosts.delete(host)
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
    await write(host, 'alive', `${Date.now()}\n`)
    const out = await read(host, 'scan.out').catch(() => null)
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
    return parseScan(host, out.replace(/^__AT__.*$/m, ''))
  }

  async function execOnce(host, script, timeoutMs = 20_000) {
    await controlWorkspace(host)
    const id = randomUUID()
    // Written under another name, then renamed: the helper never sees a half-written command.
    await write(host, `cmd/${id}.part`, `${script}\n`)
    await rpc(host, 'files.rename', {
      worktree: file(host, '').worktree,
      oldRelativePath: `${DIR}/cmd/${id}.part`,
      newRelativePath: `${DIR}/cmd/${id}.sh`,
      expectedExecutionHostId: 'local'
    })
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await sleep(400)
      const out = await read(host, `cmd/${id}.out`).catch(() => null)
      if (out === null) {
        continue
      }
      await rpc(host, 'files.delete', { ...file(host, `cmd/${id}.out`), expectedExecutionHostId: 'local' }).catch(() => {})
      const rc = Number(out.match(/__RC__(\d+)\s*$/)?.[1] ?? 0)
      const output = out.replace(/__RC__\d+\s*$/, '')
      if (rc !== 0) {
        throw Object.assign(new Error(`exit ${rc}: ${output.trim().split('\n').pop() ?? ''}`), { stdout: output })
      }
      return output
    }
    throw new Error('relay command timed out')
  }

  return { scan, exec, forget: (host) => hosts.delete(host) }
}
