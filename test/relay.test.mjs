import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { createRelay, helperScript } from '../lib/relay.mjs'

// Orca over a fake host: files live in a Map, and "the helper" answers each command file.
function fakeOrca({ helperRunning = true } = {}) {
  const files = new Map()
  const calls = []
  const workspaces = []
  const groups = []
  const rpc = async (_host, method, p) => {
    calls.push(method)
    switch (method) {
      case 'files.browseServerDir':
        return { resolvedPath: '/home/me' }
      case 'folderWorkspace.list':
        return { folderWorkspaces: structuredClone(workspaces) }
      case 'projectGroup.list':
        return { groups: structuredClone(groups) }
      case 'projectGroup.create':
        groups.push({ id: 'g1', name: p.name })
        return { group: groups.at(-1) }
      case 'folderWorkspace.create':
        workspaces.push({ id: `w${workspaces.length + 1}`, projectGroupId: p.projectGroupId, folderPath: p.folderPath })
        return { folderWorkspace: workspaces.at(-1) }
      case 'folderWorkspace.update':
        Object.assign(workspaces.find((w) => w.id === p.folderWorkspaceId), p.updates)
        return {}
      case 'folderWorkspace.delete':
        workspaces.splice(workspaces.findIndex((w) => w.id === p.folderWorkspaceId), 1)
        return {}
      case 'projectGroup.update':
        Object.assign(groups.find((g) => g.id === p.groupId), p.updates)
        return {}
      case 'projectGroup.delete':
        groups.splice(groups.findIndex((g) => g.id === p.groupId), 1)
        return {}
      case 'files.createDir':
        return {}
      case 'files.write':
        assert.equal(p.expectedExecutionHostId, 'local', 'orcad refuses writes without it')
        files.set(p.relativePath, p.content)
        if (helperRunning && /\/cmd\/[^/]+\.sh$/.test(p.relativePath)) {
          assert.match(p.content, /\n#__omux_end__\n$/, 'a command file ends with the END line')
          const out = p.relativePath.replace(/\.sh$/, '.out')
          files.set(out, p.content.includes('false') ? 'nope\n__RC__1\n' : `ran: ${p.content.split('\n')[0]}\n__RC__0\n`)
          files.delete(p.relativePath)
        }
        return { ok: true }
      case 'files.rename': {
        files.set(p.newRelativePath, files.get(p.oldRelativePath))
        files.delete(p.oldRelativePath)
        if (helperRunning) {
          const out = p.newRelativePath.replace(/\.sh$/, '.out')
          const script = files.get(p.newRelativePath)
          files.set(out, script.includes('false') ? 'nope\n__RC__1\n' : `ran: ${script}__RC__0\n`)
          files.delete(p.newRelativePath)
        }
        return { ok: true }
      }
      case 'files.read':
        if (!files.has(p.relativePath)) {
          throw new Error('ENOENT')
        }
        return { content: files.get(p.relativePath), truncated: false }
      case 'files.delete':
        files.delete(p.relativePath)
        return { ok: true }
      case 'terminal.create':
        return { terminal: { handle: 't1' } }
      default:
        throw new Error(`unexpected ${method}`)
    }
  }
  return { files, calls, rpc, workspaces, groups }
}

test('exec writes a command file and returns what the helper wrote back', async () => {
  const orca = fakeOrca()
  const relay = createRelay({ rpc: orca.rpc, state: {} })
  assert.equal(await relay.exec('h', 'tmux -V'), 'ran: tmux -V\n')
  await assert.rejects(relay.exec('h', 'false'), /exit 1: nope/)
  assert.ok(![...orca.files.keys()].some((k) => k.includes('/cmd/')), 'command files are cleaned up')
})

test('scan starts the helper once when there is no scan yet, then reads it', async () => {
  const orca = fakeOrca()
  const state = {}
  const relay = createRelay({ rpc: orca.rpc, state })
  await assert.rejects(relay.scan('h'), (err) => err.relayStarting === true)
  assert.equal(orca.calls.filter((m) => m === 'terminal.create').length, 1)
  assert.ok(orca.files.get('.orca-tmux/remote/helper.sh').includes('__RC__'))
  assert.deepEqual(state.relay.h, { group: 'g1', fw: 'w1' })
  orca.files.set('.orca-tmux/remote/scan.out', '__HOME__/home/me\n__SESSIONS__\n__PS__\n__CAP__\n__AT__1700000000\n')
  const scan = await relay.scan('h')
  assert.equal(scan.home, '/home/me')
  assert.equal(orca.calls.filter((m) => m === 'terminal.create').length, 1)
})

test('the helper runs queued commands and exits once the runner goes quiet', () => {
  const home = execFileSync('mktemp', ['-d']).toString().trim()
  const dir = `${home}/.orca-tmux/remote`
  execFileSync('sh', ['-c', `mkdir -p ${dir}/cmd && printf 'echo hi\\n#__omux_end__\\n' > ${dir}/cmd/a.sh && printf 'echo half' > ${dir}/cmd/b.sh && echo 'echo scanned' > ${dir}/scan.sh && touch ${dir}/alive`])
  // Stop the loop after one pass by making "alive" stale in the second.
  const script = helperScript(1).replace('sleep 0.2', `touch -t 200001010000 "$D/alive"; sleep 0.1`)
  execFileSync('sh', ['-c', script], { env: { ...process.env, HOME: home }, timeout: 10_000 })
  const out = execFileSync('cat', [`${dir}/cmd/a.out`, `${dir}/scan.out`]).toString()
  assert.match(out, /^hi\n__RC__0\nscanned\n__AT__\d+\n$/)
  assert.equal(execFileSync('ls', [`${dir}/cmd`]).toString().trim(), 'a.out\nb.sh', 'a half-written command waits')
  execFileSync('rm', ['-rf', home])
})

test('the workspace sits in a collapsed group without a parent folder, so Orca draws no card', async () => {
  const orca = fakeOrca()
  orca.groups.push({ id: 'sess', name: 'h · 0', parentPath: '/home/me' })
  orca.workspaces.push({ id: 'old', projectGroupId: 'sess', folderPath: '/home/me' })
  const state = { relay: { h: { group: 'sess', fw: 'old' } } } // an earlier layout: a visible card
  const relay = createRelay({ rpc: orca.rpc, state })
  await relay.exec('h', 'true')
  assert.deepEqual(orca.workspaces.map((w) => w.projectGroupId), ['g1'], 'the visible card is gone')
  const group = orca.groups.find((g) => g.id === 'g1')
  assert.equal(group.parentPath, undefined)
  assert.deepEqual([group.isCollapsed, group.tabOrder], [true, 1_000_000])
})

test('a helper from an older version is replaced once per run', async () => {
  const orca = fakeOrca()
  const relay = createRelay({ rpc: orca.rpc, state: {} })
  await assert.rejects(relay.scan('h'), (err) => err.relayStarting)
  orca.files.set('.orca-tmux/remote/scan.out', '__HOME__/home/me\n__AT__1\n')
  orca.files.set('.orca-tmux/remote/helper.sh', 'old helper')
  const next = createRelay({ rpc: orca.rpc, state: {} })
  await assert.rejects(next.scan('h'), /updating/)
  assert.notEqual(orca.files.get('.orca-tmux/remote/helper.sh'), 'old helper')
  assert.equal((await next.scan('h')).home, '/home/me')
})

test('a command that gets no answer restarts a stuck helper, and an error does not hide that it is stale', async () => {
  const orca = fakeOrca({ helperRunning: false })
  const relay = createRelay({ rpc: orca.rpc, state: {} })
  await assert.rejects(relay.exec('h', 'tmux -V', 300), /timed out/)
  assert.equal(orca.calls.filter((m) => m === 'terminal.create').length, 1, 'restarted after no answer')
  assert.ok(helperScript().includes('$T sh "$f"'), 'commands run under timeout(1) where it exists')
})

test('a scan a hook asked for bumps the "changed" counter; a periodic one does not', async () => {
  const home = execFileSync('mktemp', ['-d']).toString().trim()
  const dir = `${home}/.orca-tmux/remote`
  const run = (setup) => {
    execFileSync('sh', ['-c', `mkdir -p ${dir}/cmd && echo 'echo scanned' > ${dir}/scan.sh && touch ${dir}/alive ${setup}`])
    const script = helperScript(1).replace('sleep 0.2', `touch -t 200001010000 "$D/alive"; sleep 0.1`)
    execFileSync('sh', ['-c', script], { env: { ...process.env, HOME: home }, timeout: 10_000 })
  }
  run('')
  assert.throws(() => execFileSync('cat', [`${dir}/changed`], { stdio: 'pipe' }), 'periodic scan: no counter')
  run(`${dir}/trigger`)
  assert.equal(execFileSync('cat', [`${dir}/changed`]).toString().trim(), '1')
  const orca = fakeOrca()
  const relay = createRelay({ rpc: orca.rpc, state: {} })
  assert.equal(await relay.peek('h'), null, 'peek sets nothing up for an unknown host')
  assert.ok(!orca.calls.includes('folderWorkspace.create'))
  execFileSync('rm', ['-rf', home])
})
