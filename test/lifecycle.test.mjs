// Tab lifecycle against a fake Orca runtime and fake tmux: the only path that kills a tmux
// window/pane is the user closing exactly one tab while the session's other tabs live on.
import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ORCA_TMUX_HOME = mkdtempSync(join(tmpdir(), 'omux-test-'))
const { createSyncEngine } = await import('../lib/sync.mjs')

function fakeOrca() {
  const orca = { groups: [], workspaces: [], terminals: [], seq: 0, runtimeId: 'run-1', views: new Map() }
  const id = (p) => `${p}-${++orca.seq}`
  orca.bridge = {
    async call(_env, method, params) {
      switch (method) {
        case 'projectGroup.list':
          return { groups: orca.groups }
        case 'projectGroup.create': {
          const group = { id: id('g'), ...params }
          orca.groups.push(group)
          return { group }
        }
        case 'projectGroup.delete':
          orca.groups = orca.groups.filter((g) => g.id !== params.groupId)
          return {}
        case 'folderWorkspace.list':
          return { folderWorkspaces: orca.workspaces }
        case 'folderWorkspace.create': {
          const fw = { id: id('fw'), createdAt: Date.now(), ...params }
          orca.workspaces.push(fw)
          return { folderWorkspace: fw }
        }
        case 'folderWorkspace.update':
          Object.assign(orca.workspaces.find((f) => f.id === params.folderWorkspaceId) ?? {}, params.updates)
          return {}
        case 'folderWorkspace.delete':
          orca.workspaces = orca.workspaces.filter((f) => f.id !== params.folderWorkspaceId)
          return {}
        case 'terminal.list':
          return { terminals: orca.terminals }
        case 'terminal.create': {
          const handle = id('term')
          orca.terminals.push({ handle, worktreeId: params.worktree, title: params.title })
          // The attach command ends with: _ '<session>' '<window>' '<pane>'
          const [, , windowId, paneId] = params.command.match(/_ '([^']*)' '([^']*)' '([^']*)'$/)
          orca.views.set(paneId ? `orca-p${paneId.slice(1)}` : `orca-w${windowId.slice(1)}`, { attached: true })
          return { terminal: { handle } }
        }
        case 'terminal.closeTab':
        case 'terminal.close':
          orca.terminals = orca.terminals.filter((t) => t.handle !== params.terminal)
          return {}
        case 'terminal.rename':
        case 'repo.list':
          return { repos: [] }
        default:
          throw new Error(`unexpected ${method}`)
      }
    }
  }
  orca.cli = {
    status: async () => ({ runtime: { runtimeId: orca.runtimeId } }),
    listHosts: async () => [],
    listEnvironments: async () => []
  }
  return orca
}

// tmux: session "0" with window @1 (claude %1 + codex %2) and window @2 (no agent).
function fakeTmux(orca) {
  const tmux = { commands: [], windows: null }
  tmux.windows = [
    {
      id: '@1', index: 1, name: 'work', path: '/repo',
      panes: [
        { id: '%1', index: 1, agent: 'claude', state: 'idle', title: '✳ a' },
        { id: '%2', index: 2, agent: 'codex', state: 'idle', title: 'b' }
      ]
    },
    { id: '@2', index: 2, name: 'shell', path: '/tmp', panes: [{ id: '%3', index: 1, agent: null, state: null, title: 'zsh' }] }
  ]
  tmux.scan = async (host) => ({
    host,
    home: '/home/me',
    views: orca.views,
    sessions: [{ name: '0', windows: structuredClone(tmux.windows) }]
  })
  tmux.run = async (_host, script) => {
    tmux.commands.push(script)
    return script.includes('new-window') ? '@99\n' : ''
  }
  tmux.kills = () => tmux.commands.filter((c) => /kill-(window|pane)/.test(c))
  return tmux
}

let orca, tmux, engine
const tabFor = (paneOrWindow) => {
  const view = paneOrWindow.startsWith('%') ? `orca-p${paneOrWindow.slice(1)}` : `orca-w${paneOrWindow.slice(1)}`
  return { view }
}
async function settle() {
  await engine.tick()
  mock.timers.tick(5_000)
  await engine.tick()
}
// The user closes a tab in Orca: its terminal disappears and its tmux view detaches.
function userCloses(paneOrWindow, handle) {
  orca.terminals = orca.terminals.filter((t) => t.handle !== handle)
  orca.views.set(tabFor(paneOrWindow).view, { attached: false })
}
const handleOf = (title) => orca.terminals.find((t) => t.title.includes(title))?.handle

beforeEach(async () => {
  rmSync(join(process.env.ORCA_TMUX_HOME, 'state.json'), { force: true })
  mock.timers.reset()
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 26, 5, 0) })
  orca = fakeOrca()
  tmux = fakeTmux(orca)
  engine = createSyncEngine({ cli: orca.cli, bridge: orca.bridge, env: {}, scan: tmux.scan, runTmux: tmux.run })
  await engine.tick()
})

test('first pass: one group, a workspace per window, a tab per agent pane (or per window)', () => {
  assert.equal(orca.groups.length, 1)
  assert.equal(orca.groups[0].parentPath, '/home/me', 'the sidebar hides groups without parentPath')
  assert.deepEqual(orca.workspaces.map((f) => [f.name, f.folderPath]).sort(), [
    ['1 work', '/repo'],
    ['2 shell', '/tmp']
  ])
  assert.equal(orca.terminals.length, 3, 'claude tab + codex tab + shell window tab')
  assert.deepEqual(tmux.kills(), [])
})

test('closing one tab kills only that pane', async () => {
  await settle()
  userCloses('%2', handleOf('codex'))
  await settle()
  assert.deepEqual(tmux.kills(), [`tmux kill-pane -t '%2'`])
})

test('closing a window tab kills that window', async () => {
  await settle()
  userCloses('@2', handleOf('shell'))
  await settle()
  assert.deepEqual(tmux.kills(), [`tmux kill-window -t '@2'`])
})

test('several tabs disappearing at once (sleep, restart) kills nothing and keeps them closed', async () => {
  await settle()
  userCloses('%1', handleOf('claude'))
  userCloses('%2', handleOf('codex'))
  await settle()
  assert.deepEqual(tmux.kills(), [])
  await settle()
  assert.equal(orca.terminals.length, 1, 'dismissed tabs are not reopened')
})

test('a closed tab lingering in Orca listings for a moment does not count as a detach', async () => {
  await settle()
  const handle = handleOf('codex')
  orca.views.set('orca-p2', { attached: false }) // view gone, terminal still listed (Orca lags ~2s)
  await engine.tick()
  orca.terminals = orca.terminals.filter((t) => t.handle !== handle)
  mock.timers.tick(5_000)
  await engine.tick()
  assert.deepEqual(tmux.kills(), [`tmux kill-pane -t '%2'`])
})

test('a detach (tab still open, view gone) reopens the tab and kills nothing', async () => {
  await settle()
  const before = handleOf('codex')
  orca.views.set('orca-p2', { attached: false })
  await settle()
  assert.deepEqual(tmux.kills(), [])
  assert.ok(!orca.terminals.some((t) => t.handle === before), 'the detached tab is closed')
  assert.ok(handleOf('codex'), 'and a fresh one attached')
})

test('tabs gone after an Orca restart are recreated, never killed', async () => {
  await settle()
  orca.terminals = []
  for (const v of orca.views.keys()) {
    orca.views.set(v, { attached: false })
  }
  orca.runtimeId = 'run-2'
  mock.timers.tick(31_000) // Orca facts refresh every 30s
  await settle()
  await settle()
  assert.deepEqual(tmux.kills(), [])
  assert.equal(orca.terminals.length, 3)
})

test('a stale untracked workspace is cleaned up, a fresh one becomes one new window', async () => {
  const group = orca.groups[0].id
  orca.workspaces.push({ id: 'old', projectGroupId: group, name: 'debris', folderPath: '/x', createdAt: Date.now() - 600_000 })
  orca.workspaces.push({ id: 'new1', projectGroupId: group, name: 'mine', folderPath: '/y', createdAt: Date.now() })
  orca.workspaces.push({ id: 'new2', projectGroupId: group, name: 'mine2', folderPath: '/z', createdAt: Date.now() })
  await engine.tick()
  assert.ok(!orca.workspaces.some((f) => f.id === 'old'), 'debris removed')
  assert.equal(tmux.commands.filter((c) => c.includes('new-window')).length, 1, 'at most one adoption per pass')
})

// The user removes a window's workspace in Orca: the workspace and its tabs go away.
function userRemovesWorkspace(name) {
  const fw = orca.workspaces.find((f) => f.name === name)
  orca.workspaces = orca.workspaces.filter((f) => f !== fw)
  for (const t of orca.terminals.filter((t) => t.worktreeId === `folder:${fw.id}`)) {
    orca.terminals = orca.terminals.filter((x) => x !== t)
  }
  for (const v of orca.views.keys()) {
    if ((name === '1 work' && /^orca-p[12]$/.test(v)) || (name === '2 shell' && v === 'orca-w2')) {
      orca.views.set(v, { attached: false })
    }
  }
}

test('removing a workspace kills its tmux window', async () => {
  await settle()
  userRemovesWorkspace('1 work')
  await settle()
  assert.deepEqual(tmux.kills(), [`tmux kill-window -t '@1'`])
})

test('removing every workspace at once kills nothing and does not bring them back', async () => {
  await settle()
  userRemovesWorkspace('1 work')
  userRemovesWorkspace('2 shell')
  await settle()
  await settle()
  assert.deepEqual(tmux.kills(), [])
  assert.equal(orca.workspaces.length, 0, 'kept windows stay without a workspace')
  engine.reopenDismissed()
  await settle()
  assert.equal(orca.workspaces.length, 2, '"Reopen Closed Windows" brings them back')
})
