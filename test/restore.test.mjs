import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { agentResume, restoreIfRebooted, takeSnapshot } from '../lib/restore.mjs'

const SEP = '\x1f'
const dir = mkdtempSync(join(tmpdir(), 'omux-restore-'))
const BOOT = 1_800_000_000_000

// A fake tmux/ps/sysctl: list-panes answers `panes`, new ids are handed out in order.
function fakeExec({ panes = [], ps = '', sessions = '' } = {}) {
  const calls = []
  let w = 0
  let p = 0
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args])
    if (cmd === 'sysctl') return `{ sec = ${BOOT / 1000}, usec = 0 } Thu Jan  1`
    if (cmd === 'ps') return ps
    if (cmd === 'lsof') return ''
    if (args[0] === 'list-panes') return panes.map((f) => f.join(SEP)).join('\n') + '\n'
    if (args[0] === 'list-sessions') return sessions
    if (args[0] === 'new-session' || args[0] === 'new-window') return `@${w++}${SEP}%${p++}\n`
    if (args[0] === 'split-window') return `%${p++}\n`
    return ''
  }
  return { exec, calls }
}

// session, window id, pane id, window index, name, layout, window active, auto-rename, pane index, pane active, pid, path
const pane = (...f) => f.map(String)

test('a snapshot keeps sessions, windows, panes and the conversation of each agent pane', async () => {
  const home = join(dir, 'home')
  mkdirSync(join(home, '.claude', 'sessions'), { recursive: true })
  writeFileSync(join(home, '.claude', 'sessions', '501.json'), JSON.stringify({ pid: 501, sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }))
  const { exec } = fakeExec({
    panes: [
      pane('0', '@3', '%7', 1, 'api', 'lay1', 1, 0, 1, 1, 100, '/repo'),
      pane('0', '@3', '%8', 1, 'api', 'lay1', 1, 0, 2, 0, 200, '/repo/web'),
      pane('orca-w3', '@3', '%7', 1, 'api', 'lay1', 1, 0, 1, 1, 100, '/repo') // a view session: not saved
    ],
    ps: '  100     1 -zsh\n  501   100 claude\n  200     1 -zsh\n'
  })
  const file = join(dir, 'snap1.json')
  const snap = await takeSnapshot(file, { exec, home })
  assert.equal(snap.sessions.length, 1)
  const [win] = snap.sessions[0].windows
  assert.deepEqual(
    { id: win.id, name: win.name, layout: win.layout, panes: win.panes.map((p) => [p.id, p.path, p.agent ?? null, p.resume ?? null]) },
    { id: '@3', name: 'api', layout: 'lay1', panes: [['%7', '/repo', 'claude', '--resume aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'], ['%8', '/repo/web', null, null]] }
  )
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).sessions, snap.sessions)
})

test('an empty tmux never overwrites the snapshot', async () => {
  const file = join(dir, 'snap2.json')
  writeFileSync(file, '{"at":1,"sessions":[{"name":"0","windows":[]}]}')
  assert.equal(await takeSnapshot(file, { exec: fakeExec().exec }), null)
  assert.match(readFileSync(file, 'utf8'), /"name":"0"/)
})

const snapshot = (at) => ({
  at,
  sessions: [
    {
      name: '0',
      windows: [
        { id: '@3', index: 1, name: 'api', autoName: false, layout: 'lay1', active: true, panes: [{ id: '%7', index: 1, active: true, path: dir, agent: 'claude', resume: '--resume abc12345' }, { id: '%8', index: 2, active: false, path: '/gone/folder' }] },
        { id: '@5', index: 2, name: 'zsh', autoName: true, layout: 'lay2', active: false, panes: [{ id: '%9', index: 1, active: true, path: dir }] }
      ]
    }
  ]
})

test('after a reboot an empty tmux is rebuilt, agents typed but not run, and the new ids are returned', async () => {
  const file = join(dir, 'snap3.json')
  writeFileSync(file, JSON.stringify(snapshot(BOOT - 60_000)))
  const { exec, calls } = fakeExec()
  const ids = await restoreIfRebooted(file, { exec, home: '/home/me' })
  assert.deepEqual(ids, { '@3': '@0', '%7': '%0', '%8': '%1', '@5': '@1', '%9': '%2' })
  const tmux = calls.filter(([c]) => c === 'tmux').map(([, ...a]) => a)
  assert.deepEqual(tmux.find((a) => a[0] === 'new-session'), ['new-session', '-d', '-s', '0', '-n', 'api', '-c', dir, '-P', '-F', `#{window_id}${SEP}#{pane_id}`])
  assert.ok(tmux.some((a) => a[0] === 'split-window' && a.includes('/home/me')), 'a folder that is gone opens in home')
  assert.ok(tmux.some((a) => a.join(' ') === 'select-layout -t @0 lay1'))
  assert.ok(tmux.some((a) => a.join(' ') === 'new-window -d -t =0:2 -n zsh -c ' + dir + ' -P -F ' + `#{window_id}${SEP}#{pane_id}`))
  assert.ok(tmux.some((a) => a.join(' ') === 'set-option -w -t @1 automatic-rename on'))
  assert.deepEqual(tmux.filter((a) => a[0] === 'send-keys'), [['send-keys', '-t', '%0', '-l', 'claude --resume abc12345']], 'typed, no Enter')
})

test('nothing is restored when the snapshot is from after the boot or tmux already has sessions', async () => {
  const file = join(dir, 'snap4.json')
  writeFileSync(file, JSON.stringify(snapshot(BOOT + 60_000)))
  assert.equal(await restoreIfRebooted(file, fakeExec()), null, 'tmux was emptied on purpose, not by a reboot')
  writeFileSync(file, JSON.stringify(snapshot(BOOT - 60_000)))
  const { exec, calls } = fakeExec({ sessions: 'work\n' })
  assert.equal(await restoreIfRebooted(file, { exec }), null)
  assert.ok(!calls.some(([, a]) => a === 'new-session'))
  assert.equal(await restoreIfRebooted(file, { ...fakeExec(), config: { restore: false } }), null)
})

test('restoreAgents "run" presses enter after typing the resume command', async () => {
  const file = join(dir, 'snap5.json')
  writeFileSync(file, JSON.stringify(snapshot(BOOT - 60_000)))
  const { exec, calls } = fakeExec()
  await restoreIfRebooted(file, { exec, config: { restoreAgents: 'run' } })
  assert.deepEqual(calls.filter(([, a]) => a === 'send-keys').map((c) => c.slice(2)), [['-t', '%0', '-l', 'claude --resume abc12345'], ['-t', '%0', 'Enter']])
})

test('an agent without a known conversation resumes the latest one in its folder', async () => {
  assert.equal(await agentResume('claude', 999, 'claude', { home: dir }), '--continue')
  assert.equal(await agentResume('codex', 999, 'codex', { exec: async () => '' }), 'resume --last')
  assert.equal(
    await agentResume('codex', 999, 'codex', { exec: async () => 'n/Users/me/.codex/sessions/2026/11/27/rollout-2026-11-27T10-00-00-0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl\n' }),
    'resume 0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  )
})
