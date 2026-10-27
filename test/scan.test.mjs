import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { STATE_AWK, classifyCommand, findOrcaAgentArgs, parseDoneStamp, parseScan, resumeArgs } from '../lib/scan.mjs'

const SEP = '|#|'
const pane = (session, windowId, index, name, paneId, paneIndex, active, pid, path, title, auto = '0') =>
  [session, windowId, index, name, paneId, paneIndex, active, pid, path, auto, 'myhost', `$${session}`, title].join(SEP)

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

test('parseScan keeps what a waiting agent asks to do', () => {
  const out = scanOutput({
    panes: [pane('0', '@1', 1, 'w', '%1', 1, 1, 100, '/r', 't'), pane('0', '@1', 1, 'w', '%2', 2, 0, 200, '/r', 't')],
    ps: ['100 1 -zsh', '101 100 claude', '200 1 -zsh', '201 200 codex'],
    cap: ['%1 waiting', '%1 @ask touch /tmp/x.txt', '%2 working', '%2 @ask stale']
  })
  const [a, b] = parseScan('local', out).sessions[0].windows[0].panes
  assert.equal(a.ask, 'touch /tmp/x.txt')
  assert.equal(b.ask, null, 'only while waiting')
})

test('STATE_AWK reads state, request and done stamp from agent screens', () => {
  const run = (...panes) =>
    execFileSync('awk', [STATE_AWK], { input: panes.map(([id, screen]) => `@@PANE ${id}\n${screen.join('\n')}`).join('\n') })
      .toString()
      .trim()
      .split('\n')
  const rule = '╌'.repeat(20)
  const claude = [' Bash command', ' Create an empty file', rule, ' touch /tmp/a.txt', rule, ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', '', '']
  const codex = ['  Would you like to run the following command?', '  Reason: needs write access', '  $ touch /tmp/b.txt', '› 1. Yes, proceed (y)']
  const edit = [' Edit file', ' Do you want to make this edit to app.ts?', ' ❯ 1. Yes']
  const working = ['✻ Cooked for 5s · done 1:51 PM', '❯ next', '✶ Thinking… (3s · esc to interrupt)']
  assert.deepEqual(run(['%1', claude], ['%2', codex], ['%3', edit], ['%4', working]), [
    '%1 waiting',
    '%1 @ask touch /tmp/a.txt',
    '%2 waiting',
    '%2 @ask touch /tmp/b.txt',
    '%3 waiting',
    '%3 @ask Do you want to make this edit to app.ts?',
    '%4 working',
    '%4 @done · done 1:51 PM'
  ])
})

test('findOrcaAgentArgs picks the newest agent in an Orca terminal, not one in tmux', () => {
  const ps = [
    '10 1 3-00:00:00 /Applications/Orca.app/Contents/Frameworks/Orca Terminal Host.app/Contents/MacOS/Orca Terminal Host',
    '11 10 00:20 -zsh',
    '12 11 00:15 claude --resume 0b5d7a2e-1111-4222-8333-944455556666',
    '20 1 5-00:00:00 tmux new-session -d',
    '21 20 00:05 -zsh',
    '22 21 00:03 claude --resume ffffffff-0000-0000-0000-000000000000',
    '13 11 20:00 claude --continue'
  ].join('\n')
  assert.equal(findOrcaAgentArgs(ps, 'claude'), 'claude --resume 0b5d7a2e-1111-4222-8333-944455556666')
  assert.equal(findOrcaAgentArgs(ps, 'codex'), null)
})

test('resumeArgs keeps only the resume part of an agent command line', () => {
  assert.equal(resumeArgs('claude', 'claude --resume 0b5d7a2e-1111 --model x'), '--resume 0b5d7a2e-1111')
  assert.equal(resumeArgs('claude', '/u/bin/claude -r=abcdef123456'), '--resume abcdef123456')
  assert.equal(resumeArgs('claude', 'claude --continue'), '--continue')
  assert.equal(resumeArgs('claude', 'claude fix the login bug'), '')
  assert.equal(resumeArgs('codex', 'node /opt/homebrew/bin/codex resume 019a2b3c-4d5e'), 'resume 019a2b3c-4d5e')
  assert.equal(resumeArgs('codex', 'codex resume --last'), 'resume --last')
  assert.equal(resumeArgs('codex', 'codex'), '')
})

test('STATE_AWK has no single quote: it is passed to awk inside single quotes', () => {
  assert.ok(!STATE_AWK.includes("'"))
})

test('STATE_AWK reads the last answer, not tool calls; for claude the one before the done footer', () => {
  const run = (screen) => execFileSync('awk', [STATE_AWK], { input: `@@PANE %1\n${screen.join('\n')}` }).toString()
  const claude = ['⏺ Bash(ls)', '  ⎿  a b', '⏺ Listed the files.', '  Two of them are new.', '✻ Cooked for 3s · done 1:51 PM', '⏺ Stopped watching Artifact', '❯ ']
  assert.match(run(claude), /^%1 @msg Listed the files\. Two of them are new\.$/m)
  const codex = ['• Ran npm test', '• All 12 tests pass.', '• Called linear.get_issue', '› next']
  assert.match(run(codex), /^%1 @msg All 12 tests pass\.$/m)
})
