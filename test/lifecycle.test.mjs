// Tab lifecycle against a fake Orca runtime and fake tmux: the only path that kills a tmux
// window/pane is the user closing exactly one tab while the session's other tabs live on.
import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ORCA_TMUX_HOME = mkdtempSync(join(tmpdir(), 'omux-test-'))
const { createSyncEngine, hookScript } = await import('../lib/sync.mjs')

function fakeOrca() {
  const orca = { groups: [], workspaces: [], terminals: [], repos: [], meta: new Map(), seq: 0, runtimeId: 'run-1', views: new Map(), lanes: [{ id: 'todo', label: 'Todo' }] }
  const id = (p) => `${p}-${++orca.seq}`
  orca.calls = []
  orca.sent = []
  orca.bridge = {
    async call(_env, method, params) {
      orca.calls.push(method)
      switch (method) {
        case 'projectGroup.list':
          return { groups: orca.groups }
        case 'projectGroup.create': {
          const group = { id: id('g'), ...params }
          orca.groups.push(group)
          return { group }
        }
        case 'projectGroup.update':
          Object.assign(orca.groups.find((g) => g.id === params.groupId) ?? {}, params.updates)
          return {}
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
        case 'repo.list':
          return { repos: orca.repos }
        case 'repo.add': {
          const repo = { id: id('repo'), path: params.path, kind: params.kind, projectGroupId: null }
          orca.repos.push(repo)
          return { repo }
        }
        case 'repo.rm':
          orca.repos = orca.repos.filter((r) => `id:${r.id}` !== params.repo)
          return {}
        case 'projectGroup.moveProject':
          orca.repos.find((r) => `id:${r.id}` === params.repo).projectGroupId = params.groupId
          return {}
        case 'worktree.list':
          return { worktrees: orca.repos.map((r) => ({ id: `${r.id}::${r.path}`, path: r.path, ...orca.meta.get(`${r.id}::${r.path}`) })) }
        case 'worktree.set': {
          const { worktree, ...updates } = params
          const key = worktree.replace(/^id:/, '')
          orca.meta.set(key, { ...orca.meta.get(key), ...updates })
          return {}
        }
        case 'terminal.create': {
          const handle = id('term')
          orca.terminals.push({ handle, worktreeId: params.worktree.replace(/^id:/, ''), title: params.title })
          // The attach command ends with: _ '<session>' '<window>' '<pane>'
          const [, , windowId, paneId] = params.command.match(/_ '([^']*)' '([^']*)' '([^']*)'$/)
          orca.views.set(paneId ? `orca-p${paneId.slice(1)}` : `orca-w${windowId.slice(1)}`, { attached: true, tty: `/dev/ttys0${paneId?.slice(1) ?? 0}` })
          return { terminal: { handle } }
        }
        case 'terminal.closeTab':
        case 'terminal.close':
          orca.terminals = orca.terminals.filter((t) => t.handle !== params.terminal)
          return {}
        case 'terminal.rename':
          return {}
        case 'terminal.send': {
          // Typed into a tab's shell: an attach command makes that tab the window's view.
          orca.sent.push(params)
          const [, , windowId, paneId] = params.text.match(/_ '([^']*)' '([^']*)' '([^']*)'$/) ?? []
          if (windowId) {
            orca.views.set(paneId ? `orca-p${paneId.slice(1)}` : `orca-w${windowId.slice(1)}`, { attached: true, tty: '/dev/ttys099' })
          }
          return {}
        }
        case 'terminal.isRunningAgent':
          return { isRunningAgent: Boolean(orca.terminals.find((t) => t.handle === params.terminal)?.screen) }
        case 'terminal.read':
          return { terminal: { tail: orca.terminals.find((t) => t.handle === params.terminal)?.screen ?? [] } }
        case 'ui.get':
          return { ui: { workspaceStatuses: orca.lanes } }
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
  tmux.extraSessions = [] // sessions created through new-session
  tmux.sessionName = '0'
  tmux.scan = async (host) => ({
    host,
    home: '/home/me',
    views: orca.views,
    sessions: [{ name: tmux.sessionName, id: '$0', windows: structuredClone(tmux.windows) }, ...structuredClone(tmux.extraSessions)]
  })
  tmux.nested = [] // "<window folder>\t<changed repo>" lines the nested scan reports
  tmux.run = async (_host, script) => {
    tmux.commands.push(script)
    const session = script.match(/rename-session -t '=([^']*)' '([^']*)'$/)
    if (session && session[1] === tmux.sessionName) {
      tmux.sessionName = session[2]
    }
    const renamed = script.match(/^tmux rename-window -t '(@\d+)' '([^']*)'$/)
    if (renamed) {
      tmux.windows.find((w) => w.id === renamed[1]).name = renamed[2]
    }
    const created = script.match(/new-session -d -s '([^']+)'/)
    if (created) {
      tmux.extraSessions.push({
        name: created[1],
        windows: [{ id: '@50', index: 1, name: 'zsh', path: '/home/me', panes: [{ id: '%50', index: 1, agent: null, state: null, title: 'zsh' }] }]
      })
    }
    if (script.startsWith('ps -eo')) {
      return tmux.ps ?? ''
    }
    if (script.includes('-name .git -print')) {
      return tmux.nested.join('\n') + '\n'
    }
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
// Agent tabs are titled by their task: the fake claude pane's is "a", the codex pane's "b".
const TASK = { claude: 'a', codex: 'b' }
const handleOf = (name) =>
  (TASK[name] ? orca.terminals.find((t) => t.title === TASK[name]) : orca.terminals.find((t) => t.title.includes(name)))?.handle

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

// --- git project cards (window folder inside a repo, like VS Code) --------------------------

function gitWindows() {
  tmux.windows = [
    { id: '@1', index: 1, name: 'api', path: '/src/app/api', gitRoot: '/src/app', panes: [{ id: '%1', index: 1, agent: 'claude', state: 'idle', title: '✳ a' }] },
    { id: '@2', index: 2, name: 'web', path: '/src/app/web', gitRoot: '/src/app', panes: [{ id: '%2', index: 1, agent: 'codex', state: 'idle', title: 'b' }] },
    { id: '@3', index: 3, name: 'notes', path: '/notes', gitRoot: null, panes: [{ id: '%3', index: 1, agent: null, state: null, title: 'zsh' }] }
  ]
}

test('a window inside a git repo gets the repo as a git card in its session group', async () => {
  gitWindows()
  await settle()
  assert.equal(orca.repos.length, 1, 'one card for the shared repo')
  assert.equal(orca.repos[0].path, '/src/app')
  assert.equal(orca.repos[0].projectGroupId, orca.groups[0].id)
  assert.deepEqual(orca.workspaces.map((f) => f.name), ['3 notes'], 'non-git window keeps a folder workspace')
  const onRepo = orca.terminals.filter((t) => t.worktreeId === `${orca.repos[0].id}::/src/app`)
  assert.equal(onRepo.length, 2, 'both windows\' agent tabs live on the shared card')
  assert.equal(orca.meta.get(`${orca.repos[0].id}::/src/app`).displayName, 'app', 'a shared card shows the repo name')
})

test('tabs of two windows on one git card are never mistaken for "+" tabs', async () => {
  gitWindows()
  await settle()
  await settle()
  await settle()
  assert.equal(tmux.commands.filter((c) => c.includes('new-window')).length, 0)
  assert.deepEqual(tmux.kills(), [])
})

test('Orca\'s default shell in a just-added git card is closed, not turned into a window', async () => {
  gitWindows()
  await engine.tick()
  const card = `${orca.repos[0].id}::/src/app`
  orca.terminals.push({ handle: 'default-shell', worktreeId: card, title: 'Terminal 1' })
  await settle()
  assert.ok(!orca.terminals.some((t) => t.handle === 'default-shell'))
  assert.equal(tmux.commands.filter((c) => c.includes('new-window')).length, 0)
})

test('removing a git card used by one window kills that window', async () => {
  tmux.windows[0].gitRoot = '/repo' // "1 work" is in a repo, "2 shell" is not
  await settle()
  await settle()
  const repo = orca.repos[0]
  orca.repos = []
  orca.terminals = orca.terminals.filter((t) => !t.worktreeId.startsWith(repo.id))
  orca.views.set('orca-p1', { attached: false })
  orca.views.set('orca-p2', { attached: false })
  await settle()
  assert.deepEqual(tmux.kills(), [`tmux kill-window -t '@1'`])
})

test('cd out of a repo moves the window to a folder workspace and drops the unused git card', async () => {
  tmux.windows[0].gitRoot = '/repo'
  await settle()
  assert.equal(orca.repos.length, 1)
  tmux.windows[0].gitRoot = null
  tmux.windows[0].path = '/elsewhere'
  await settle()
  await settle()
  assert.deepEqual(tmux.kills(), [], 'moving cards never kills')
  assert.ok(orca.workspaces.some((f) => f.name === '1 work' && f.folderPath === '/elsewhere'))
  mock.timers.tick(121_000)
  await engine.tick()
  assert.equal(orca.repos.length, 0, 'the card this tool added is unregistered once unused')
})

// --- changed repos nested in a non-git window's folder -----------------------------------

const nestedCard = () => orca.repos.find((r) => r.path === '/repo/va-vault')
const withLane = () => orca.lanes.push({ id: 'repos-lane', label: '저장소' })

test('a changed repo inside a window folder gets a card in the 저장소 lane, without tabs', async () => {
  withLane()
  tmux.nested = ['/repo\t/repo/va-vault']
  mock.timers.tick(61_000)
  await settle()
  const repo = nestedCard()
  assert.ok(repo, 'card added')
  assert.equal(repo.projectGroupId, orca.groups[0].id)
  const meta = orca.meta.get(`${repo.id}::/repo/va-vault`)
  assert.equal(meta.workspaceStatus, 'repos-lane')
  assert.equal(meta.displayName, 'work/va-vault')
  assert.equal(orca.terminals.filter((t) => t.worktreeId.startsWith(repo.id)).length, 0, 'no agent tabs on it')
  await settle()
  assert.equal(orca.repos.filter((r) => r.path === '/repo/va-vault').length, 1, 'not added twice')
  assert.deepEqual(tmux.kills(), [])
})

test('without a 저장소 lane, no nested cards are added', async () => {
  tmux.nested = ['/repo\t/repo/va-vault']
  mock.timers.tick(61_000)
  await settle()
  assert.equal(nestedCard(), undefined)
})

test('a nested card leaves 10 minutes after its repo is clean again', async () => {
  withLane()
  tmux.nested = ['/repo\t/repo/va-vault']
  mock.timers.tick(61_000)
  await settle()
  assert.ok(nestedCard())
  tmux.nested = []
  mock.timers.tick(61_000)
  await settle()
  assert.ok(nestedCard(), 'kept during the grace period')
  mock.timers.tick(600_000)
  await settle()
  assert.equal(nestedCard(), undefined)
})

test('a nested card the user removed is not added back', async () => {
  withLane()
  tmux.nested = ['/repo\t/repo/va-vault']
  mock.timers.tick(61_000)
  await settle()
  orca.repos = orca.repos.filter((r) => r.path !== '/repo/va-vault')
  mock.timers.tick(61_000)
  await settle()
  await settle()
  assert.equal(nestedCard(), undefined)
  assert.deepEqual(tmux.kills(), [], 'removing a nested card never touches tmux')
})

// --- creating from Orca ----------------------------------------------------------------------

test('a group added in Orca as "local · <name>" becomes a tmux session, kept as its group', async () => {
  const group = { id: 'user-group', name: 'local · api: v2', parentPath: '/src', createdAt: Date.now() }
  orca.groups.push(group)
  await engine.tick()
  assert.ok(tmux.commands.some((c) => c.includes(`new-session -d -s 'api_ v2' -c '/src'`)), 'tmux-safe session name')
  assert.equal(group.name, 'local · api_ v2', 'the group is renamed to the real session name')
  await settle()
  assert.ok(orca.groups.some((g) => g.id === 'user-group'), 'the group is kept, not treated as a leftover')
  assert.ok(orca.workspaces.some((f) => f.projectGroupId === 'user-group'), 'and gets the new session\'s window')
})

test('an old untracked group named like ours is still cleaned up as a leftover', async () => {
  orca.groups.push({ id: 'stale', name: 'local · gone', parentPath: '/x', createdAt: Date.now() - 600_000 })
  await engine.tick()
  assert.ok(!orca.groups.some((g) => g.id === 'stale'))
  assert.ok(!tmux.commands.some((c) => c.includes('new-session')))
})

test('a workspace added as "claude <name>" opens a window running claude, named <name>', async () => {
  const group = orca.groups[0].id
  orca.workspaces.push({ id: 'ws-claude', projectGroupId: group, name: 'claude fix login', folderPath: '/repo/web', createdAt: Date.now() })
  await engine.tick()
  const cmd = tmux.commands.find((c) => c.includes('send-keys'))
  assert.ok(tmux.commands.some((c) => c.includes(`new-window -d -P -F '#{window_id}' -c '/repo/web'`)))
  assert.match(cmd, /send-keys -t '@99' -l 'claude'/)
  assert.match(cmd, /rename-window -t '@99' 'fix login'/)
})

test('a plain workspace name opens a plain shell window', async () => {
  orca.workspaces.push({ id: 'ws-plain', projectGroupId: orca.groups[0].id, name: 'notes', folderPath: '/notes', createdAt: Date.now() })
  await engine.tick()
  assert.ok(tmux.commands.some((c) => c.includes('new-window')))
  assert.ok(!tmux.commands.some((c) => c.includes('send-keys')))
})

test('a workspace created with an agent picked in Orca runs it in tmux and closes Orca\'s agent tab', async () => {
  orca.workspaces.push({ id: 'ws-pick', projectGroupId: orca.groups[0].id, name: 'fix login', folderPath: '/notes', createdAt: Date.now(), createdWithAgent: 'codex' })
  orca.terminals.push({ handle: 'orca-agent', worktreeId: 'folder:ws-pick', title: 'codex' })
  await engine.tick()
  const cmd = tmux.commands.find((c) => c.includes('send-keys'))
  assert.match(cmd, /send-keys -t '@99' -l 'codex'/)
  assert.match(cmd, /rename-window -t '@99' 'fix login'/)
  assert.ok(cmd.includes(` \\; send-keys -t '@99' Enter \\; rename-window`), 'one shell command: tmux gets the ; itself')
  tmux.windows.push({ id: '@99', index: 3, name: 'fix login', path: '/notes', panes: [{ id: '%99', index: 1, agent: 'codex', state: 'idle', title: 'x' }] })
  await engine.tick()
  assert.ok(!orca.terminals.some((t) => t.handle === 'orca-agent'), 'the agent runs once, inside tmux')
  assert.equal(tmux.commands.filter((c) => c.includes('new-window')).length, 1, 'Orca\'s agent tab is not a "+" tab')
})

test('the dialog\'s default name does not rename the window', async () => {
  orca.workspaces.push({ id: 'ws-def', projectGroupId: orca.groups[0].id, name: 'local · 0 workspace', folderPath: '/notes', createdAt: Date.now(), createdWithAgent: 'claude' })
  await engine.tick()
  const cmd = tmux.commands.find((c) => c.includes('send-keys'))
  assert.match(cmd, /-l 'claude'/)
  assert.doesNotMatch(cmd, /rename-window/)
})

// The user presses "+" in the tab bar of window @2's card: Orca opens a tab there.
function plusTab(screen, handle = 'plus') {
  const fw = orca.workspaces.find((f) => f.name.includes('shell'))
  orca.terminals.push({ handle, worktreeId: `folder:${fw.id}`, title: 'Terminal 9', screen })
}

test('a plain "+" tab becomes a plain tmux window in that folder', async () => {
  plusTab(undefined)
  await settle()
  assert.ok(tmux.commands.some((c) => c.includes(`new-window -d -P -F '#{window_id}' -c '/tmp'`)))
  assert.ok(!tmux.commands.some((c) => c.includes('send-keys')))
  assert.ok(!orca.terminals.some((t) => t.handle === 'plus'))
})

test('Claude or Codex picked in the "+" menu runs in the new tmux window, not in the Orca tab', async () => {
  plusTab(['  Update available · 0.163.0 → 0.164.0', '  Release notes: https://github.com/openai/codex/releases/latest'])
  await settle()
  assert.match(tmux.commands.find((c) => c.includes('send-keys')), /send-keys -t '@99' -l 'codex'/)
  assert.ok(!orca.terminals.some((t) => t.handle === 'plus'), 'the agent runs once, inside tmux')
  tmux.commands = []
  plusTab([' ▐▛███▛█   Claude Code v2.1.310'], 'plus2')
  await settle()
  assert.match(tmux.commands.find((c) => c.includes('send-keys')), /-l 'claude'/)
})

test('renaming a workspace in Orca renames its tmux window', async () => {
  const fw = orca.workspaces.find((f) => f.name === '2 shell')
  fw.name = 'notes'
  await engine.tick()
  assert.ok(tmux.commands.some((c) => c === `tmux rename-window -t '@2' 'notes'`))
  assert.equal(fw.name, '2 notes', 'the workspace keeps the index prefix')
  tmux.commands = []
  await engine.tick()
  assert.ok(!tmux.commands.some((c) => c.includes('rename-window')), 'renamed once')
  assert.equal(fw.name, '2 notes')
})

test('a rename in tmux updates the workspace without renaming back', async () => {
  tmux.windows[1].name = 'logs'
  await engine.tick()
  assert.ok(!tmux.commands.some((c) => c.includes('rename-window')))
  assert.equal(orca.workspaces.find((f) => f.folderPath === '/tmp').name, '2 logs')
})

test('each agent tab gets Orca\'s in-band status, resent only on change', async () => {
  const sends = () => tmux.commands.filter((c) => c.includes(']9999;'))
  await engine.tick()
  const first = sends().join('\n')
  assert.match(first, /"state":"done","agentType":"claude".*> \/dev\/ttys01/)
  assert.match(first, /"agentType":"codex".*> \/dev\/ttys02/)
  tmux.commands = []
  await engine.tick()
  assert.equal(sends().length, 0, 'unchanged: nothing resent')
  tmux.windows[0].panes[0].state = 'waiting'
  tmux.windows[0].panes[0].ask = 'npm publish'
  await engine.tick()
  assert.equal(sends().length, 1)
  assert.match(sends()[0], /"state":"waiting".*"toolName":"Bash","toolInput":"npm publish"/)
})

test('a conversation Orca resumed in a new tab continues in the tmux window', async () => {
  tmux.ps = [
    '10 1 3-00:00:00 /x/Orca Terminal Host.app/Contents/MacOS/Orca Terminal Host',
    '11 10 00:09 -zsh',
    '12 11 00:08 claude --resume 0b5d7a2e-1111-4222-8333-944455556666'
  ].join('\n')
  plusTab([' ▐▛███▛█   Claude Code v2.1.310'], 'resumed')
  await settle()
  assert.match(tmux.commands.find((c) => c.includes('send-keys')), /-l 'claude --resume 0b5d7a2e-1111-4222-8333-944455556666'/)
})

// --- light checks between full passes ------------------------------------------------------

const fullPasses = () => orca.calls.filter((m) => m === 'worktree.list').length

test('an unchanged host is not fully synced again until 30s have passed', async () => {
  await engine.tick()
  const before = fullPasses()
  await engine.tick()
  await engine.tick()
  assert.equal(fullPasses(), before, 'nothing changed: only the light check ran')
  mock.timers.tick(31_000)
  await engine.tick()
  assert.equal(fullPasses(), before + 1, 'one full pass every 30s regardless')
})

test('a change in tmux or Orca gets a full pass at once', async () => {
  await engine.tick()
  const before = fullPasses()
  tmux.windows[0].panes[0].state = 'working'
  await engine.tick()
  assert.equal(fullPasses(), before + 1)
  orca.workspaces.find((f) => f.name === '2 shell').name = 'renamed'
  await engine.tick()
  assert.equal(fullPasses(), before + 2)
})

test('a new "+" tab asks for a quick follow-up and becomes a window within 1.5s', async () => {
  await engine.tick()
  plusTab(undefined, 'quick')
  const first = await engine.tick()
  assert.equal(first.soon, true, 'the tab is settling: look again in a second')
  mock.timers.tick(1_600)
  await engine.tick()
  assert.ok(tmux.commands.some((c) => c.includes(`new-window -d -P -F '#{window_id}' -c '/tmp'`)))
})

test('hookScript installs idempotent hooks that touch the trigger file', () => {
  const script = hookScript('/home/me/.orca-tmux/trigger')
  assert.match(script, /set-hook -g 'after-new-window\[77\]' "run-shell -b 'touch \/home\/me\/\.orca-tmux\/trigger'"/)
  assert.match(script, /'window-unlinked\[77\]'/)
  assert.match(script, /'session-created\[77\]'/)
})

test('probe notices a tab opened in Orca between passes', async () => {
  await engine.tick()
  assert.equal(await engine.probe(), false)
  assert.equal(await engine.probe(), false, 'nothing new')
  plusTab(undefined, 'probe-me')
  assert.equal(await engine.probe(), true)
})

// --- session names ---------------------------------------------------------------------------

test('renaming a tmux session renames its group (same group, same cards)', async () => {
  const group = orca.groups[0].id
  const cards = orca.workspaces.map((w) => w.id)
  tmux.sessionName = 'work'
  await engine.tick()
  assert.deepEqual(orca.groups.map((g) => [g.id, g.name]), [[group, 'local · work']])
  assert.deepEqual(orca.workspaces.map((w) => w.id), cards, 'no card was recreated')
})

test('renaming a group in Orca renames its tmux session', async () => {
  orca.groups[0].name = 'api' // the "<host> · " prefix may be left out
  await engine.tick()
  assert.ok(tmux.commands.some((c) => c.endsWith(`rename-session -t '=0' 'api'`)))
  assert.equal(tmux.sessionName, 'api')
  assert.equal(orca.groups[0].name, 'local · api')
  tmux.commands = []
  await engine.tick()
  assert.ok(!tmux.commands.some((c) => c.includes('rename-session')), 'renamed once')
  assert.equal(orca.groups.length, 1)
})

test('a plain "+" tab on a git card stays and becomes the new window\'s tab', async () => {
  gitWindows()
  await settle()
  mock.timers.tick(31_000) // past the window where Orca's default shell in a new git card is closed
  await settle()
  const card = orca.terminals.find((t) => t.worktreeId.includes('::'))?.worktreeId
  tmux.commands = []
  orca.terminals.push({ handle: 'stay', worktreeId: card, title: 'Terminal 3' })
  await settle()
  assert.ok(orca.terminals.some((t) => t.handle === 'stay'), 'the tab was not closed')
  assert.match(orca.sent.find((p) => p.terminal === 'stay')?.text ?? '', /^exec sh -c .* '@99' ''$/)
  // The new window shows up in tmux; its tab is the one already there.
  tmux.windows.push({ id: '@99', index: 4, name: 'zsh', path: '/src/app/api', gitRoot: '/src/app', panes: [{ id: '%99', index: 1, agent: null, state: null, title: 'zsh' }] })
  const created = orca.calls.filter((m) => m === 'terminal.create').length
  await settle()
  assert.equal(orca.calls.filter((m) => m === 'terminal.create').length, created, 'no second tab for it')
})

test('agent tabs read "<idle age> · <task>", without agent name or state glyph', async () => {
  assert.deepEqual(orca.terminals.map((t) => t.title).filter((t) => !/^\d /.test(t)).sort(), ['a', 'b'])
  mock.timers.tick(3 * 60_000)
  await engine.tick()
  const renames = orca.calls.filter((m) => m === 'terminal.rename').length
  assert.ok(renames > 0, 'titles follow the idle age')
})
