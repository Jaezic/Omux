import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyCommand, parseDoneStamp, parseScan } from '../lib/scan.mjs'

const SEP = '|#|'
const pane = (session, windowId, index, name, paneId, paneIndex, active, pid, path, title) =>
  [session, windowId, index, name, paneId, paneIndex, active, pid, path, title].join(SEP)

function scanOutput({ panes, sessions = [], ps = [], cap = [] }) {
  return [
    '__HOME__/home/me',
    ...panes,
    '__SESSIONS__',
    ...sessions,
    '__PS__',
    ...ps,
    '__CAP__',
    ...cap,
    ''
  ].join('\n')
}

test('classifyCommand recognizes claude and codex launchers', () => {
  assert.equal(classifyCommand('claude --dangerously-skip-permissions'), 'claude')
  assert.equal(classifyCommand('/usr/local/bin/claude'), 'claude')
  assert.equal(classifyCommand('node /opt/homebrew/bin/codex'), 'codex')
  assert.equal(classifyCommand('node /x/node_modules/@openai/codex/bin/codex.js'), 'codex')
  assert.equal(classifyCommand('codex resume'), 'codex')
  assert.equal(classifyCommand('zsh'), null)
  assert.equal(classifyCommand('vim claude.md'), null)
})

test('parseScan finds agents in pane process trees and reads screen state', () => {
  const out = scanOutput({
    panes: [
      pane('0', '@1', 1, 'work', '%1', 1, 1, 100, '/repo', '✳ task'),
      pane('0', '@1', 1, 'work', '%2', 2, 0, 200, '/repo', 'codex title'),
      pane('0', '@2', 2, 'shell', '%3', 1, 1, 300, '/tmp', 'host')
    ],
    ps: ['100 1 -zsh', '101 100 claude --resume', '200 1 -zsh', '201 200 node /opt/homebrew/bin/codex', '300 1 -zsh'],
    cap: ['%1 working', '%2 @done Oct 21 at 1:13 PM']
  })
  const scan = parseScan('local', out)
  assert.equal(scan.home, '/home/me')
  const [win1, win2] = scan.sessions[0].windows
  assert.deepEqual(
    win1.panes.map((p) => [p.id, p.agent, p.state]),
    [
      ['%1', 'claude', 'working'],
      ['%2', 'codex', 'idle']
    ]
  )
  assert.ok(win1.panes[1].doneAt > 0)
  assert.equal(win2.panes[0].agent, null)
  assert.equal(win1.path, '/repo', 'window path is the active pane path')
})

test('parseScan skips view sessions and gives a grouped window to the first session only', () => {
  const out = scanOutput({
    panes: [
      pane('0', '@1', 1, 'a', '%1', 1, 1, 100, '/a', 't'),
      pane('mirror', '@1', 1, 'a', '%1', 1, 1, 100, '/a', 't'),
      pane('orca-w1', '@1', 1, 'a', '%1', 1, 1, 100, '/a', 't'),
      pane('orca-p1', '@1', 1, 'a', '%1', 1, 1, 100, '/a', 't')
    ],
    sessions: [`0${SEP}1${SEP}@1`, `orca-w1${SEP}1${SEP}@1`, `orca-p1${SEP}0${SEP}@1`, `apv1${SEP}1${SEP}@1`]
  })
  const scan = parseScan('local', out)
  assert.deepEqual(
    scan.sessions.map((s) => [s.name, s.windows.length]),
    [['0', 1]],
    'the grouped session "mirror" must not claim window @1 again'
  )
  assert.equal(scan.views.get('orca-w1').attached, true)
  assert.equal(scan.views.get('orca-p1').attached, false)
  assert.equal(scan.views.has('apv1'), false, 'only orca-w<N>/orca-p<N> count as views')
})

test('parseDoneStamp reads claude and codex footers relative to now', () => {
  const now = new Date(2026, 9, 26, 14, 0) // Mon Oct 26 2026 14:00 local
  const at = (t) => new Date(parseDoneStamp(t, now))
  assert.deepEqual([at('· done 1:51 PM').getDate(), at('· done 1:51 PM').getHours()], [26, 13])
  assert.equal(at('· done 3:00 PM').getDate(), 25, 'a later clock time today means yesterday')
  assert.equal(at('· done Wednesday 1:51 PM').getDate(), 21)
  assert.equal(at('· done Monday 9:00 AM').getDate(), 19, 'the same weekday means a week ago')
  const codex = at('Oct 21 at 1:13 PM')
  assert.deepEqual([codex.getMonth(), codex.getDate(), codex.getHours(), codex.getMinutes()], [9, 21, 13, 13])
  assert.equal(at('Dec 30 at 1:00 PM').getFullYear(), 2025, 'a future date belongs to last year')
  assert.equal(parseDoneStamp('no clock here', now), null)
})
