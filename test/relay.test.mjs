import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { createRelay, helperScript } from '../lib/relay.mjs'

// Orca over a fake host: files live in a Map, and "the helper" answers each command file.
function fakeOrca({ helperRunning = true } = {}) {
  const files = new Map()
  const calls = []
  const rpc = async (_host, method, p) => {
    calls.push(method)
    switch (method) {
      case 'files.browseServerDir':
        return { resolvedPath: '/home/me' }
      case 'folderWorkspace.list':
        return { folderWorkspaces: [] }
      case 'projectGroup.list':
        return { groups: [] }
      case 'projectGroup.create':
        return { group: { id: 'g1' } }
      case 'folderWorkspace.create':
        return { folderWorkspace: { id: 'w1' } }
      case 'files.createDir':
        return {}
      case 'files.write':
        assert.equal(p.expectedExecutionHostId, 'local', 'orcad refuses writes without it')
        files.set(p.relativePath, p.content)
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
  return { files, calls, rpc }
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
  execFileSync('sh', ['-c', `mkdir -p ${dir}/cmd && printf 'echo hi' > ${dir}/cmd/a.sh && echo 'echo scanned' > ${dir}/scan.sh && touch ${dir}/alive`])
  // Stop the loop after one pass by making "alive" stale in the second.
  const script = helperScript(1).replace('sleep 0.5', `touch -t 200001010000 "$D/alive"; sleep 0.1`)
  execFileSync('sh', ['-c', script], { env: { ...process.env, HOME: home }, timeout: 10_000 })
  const out = execFileSync('cat', [`${dir}/cmd/a.out`, `${dir}/scan.out`]).toString()
  assert.match(out, /^hi\n__RC__0\nscanned\n__AT__\d+\n$/)
  execFileSync('rm', ['-rf', home])
})
