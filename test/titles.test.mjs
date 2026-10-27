import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ORCA_TMUX_HOME = mkdtempSync(join(tmpdir(), 'omux-test-'))
const { attachCommand } = await import('../lib/attach-command.mjs')
const { agentStatusPayload, agentTask, cardName, idleAge, orcaTitle, stateAge, windowTitle } = await import('../lib/sync.mjs')

test('idleAge buckets idle time and stays empty otherwise', () => {
  const now = Date.now()
  const idle = (minutes) => ({ state: 'idle', since: now - minutes * 60_000 })
  assert.equal(idleAge(idle(0), now), '')
  assert.equal(idleAge(idle(3), now), '3m')
  assert.equal(idleAge(idle(17), now), '15m')
  assert.equal(idleAge(idle(61), now), '1h')
  assert.equal(idleAge(idle(3000), now), '2d')
  assert.equal(idleAge({ state: 'working', since: now - 3_600_000 }, now), '')
})

test('orcaTitle uses the markers Orca reads as working / idle / waiting', () => {
  assert.match(orcaTitle({ agent: 'claude', state: 'working', title: '✳ fix bug' }), /^⠋ claude · fix bug$/)
  assert.match(orcaTitle({ agent: 'claude', state: 'idle', title: '✳ fix bug' }), /^✳ claude · fix bug/)
  assert.match(orcaTitle({ agent: 'codex', state: 'waiting', title: 'deploy' }), /^codex - action required · deploy$/)
  assert.equal(orcaTitle({ agent: 'claude', state: 'waiting', title: '✳ fix', ask: 'npm publish' }), 'claude - action required · npm publish · fix')
  assert.doesNotMatch(orcaTitle({ agent: 'codex', state: 'idle', title: 'x' }), /^✳/, 'only claude idle uses ✳')
})

test('windowTitle summarizes agents', () => {
  const window = {
    index: 5,
    name: 'robot',
    panes: [
      { agent: 'claude', state: 'idle' },
      { agent: 'codex', state: 'working' },
      { agent: null, state: null }
    ]
  }
  assert.equal(windowTitle(window), '5 robot · ✳claude ⠿codex')
  assert.equal(windowTitle({ index: 3, name: 'zsh', panes: [{ agent: null }] }), '3 zsh')
})

test('attachCommand is a single line and quotes untrusted session names', () => {
  const cmd = attachCommand("it's mine", '@4', '%12')
  assert.doesNotMatch(cmd, /\n/, 'typed into a shell: a newline would run it early')
  assert.ok(cmd.includes(`'it'\\''s mine'`))
  assert.ok(cmd.endsWith(`'@4' '%12'`))
  assert.ok(cmd.includes('active-pane'), 'pane tabs get an independent active pane')
  assert.ok(cmd.includes('status off') && cmd.includes('bell-action none'))
})

test('agentStatusPayload maps tmux states to Orca agent status records', () => {
  assert.deepEqual(agentStatusPayload({ agent: 'codex', state: 'working', since: 5 }), { state: 'working', agentType: 'codex', stateStartedAt: 5 })
  assert.deepEqual(agentStatusPayload({ agent: 'claude', state: 'idle', since: 5 }), { state: 'done', agentType: 'claude', stateStartedAt: 5, turnCompletedAt: 5 })
  assert.equal(agentStatusPayload({ agent: 'claude', state: 'waiting', since: 5, ask: 'Do you want to make this edit to a.ts?' }).toolName, undefined)
})

test('agentTask reads the task claude and codex put in their titles, not defaults', () => {
  assert.equal(agentTask({ agent: 'claude', title: '✳ Fix login bug', hostShort: 'box' }), 'Fix login bug')
  assert.equal(agentTask({ agent: 'claude', title: '⠂ Fix login bug' }), 'Fix login bug')
  assert.equal(agentTask({ agent: 'codex', title: 'Review the API | backend', hostShort: 'box' }), 'Review the API')
  assert.equal(agentTask({ agent: 'claude', title: '✳ Claude Code' }), '')
  assert.equal(agentTask({ agent: 'codex', title: 'box', hostShort: 'box' }), '', "tmux's default title is the host name")
})

test('cardName keeps names people gave and replaces the ones tmux made up', () => {
  const claude = { agent: 'claude', active: true, title: '✳ Tag the release' }
  assert.equal(cardName({ index: 6, name: '2.1.303', autoName: true, panes: [claude] }), '6 Tag the release')
  assert.equal(cardName({ index: 6, name: 'api', autoName: false, panes: [claude] }), '6 api', 'a chosen name stays')
  assert.equal(cardName({ index: 2, name: '2.1.303', autoName: true, panes: [{ agent: 'claude', title: '✳ Claude Code' }] }), '2 claude')
  assert.equal(cardName({ index: 3, name: 'zsh', autoName: true, panes: [{ agent: null, title: 'box' }] }), '3 zsh')
})

test('agentStatusPayload carries the task for Orca notifications and the dashboard', () => {
  const done = agentStatusPayload({ agent: 'claude', state: 'idle', since: 5, title: '✳ Tag the release' })
  assert.equal(done.prompt, 'Tag the release')
  assert.equal(done.lastAssistantMessage, 'Tag the release', 'the notification body')
  assert.equal(agentStatusPayload({ agent: 'claude', state: 'working', since: 5, title: '✳ Claude Code' }).prompt, undefined)
})

test('stateAge counts working and waiting time too; idleAge only idle time', () => {
  const now = Date.now()
  const working = { state: 'working', since: now - 12 * 60_000 }
  assert.equal(stateAge(working, now), '10m')
  assert.equal(idleAge(working, now), '')
  assert.equal(stateAge({ state: 'waiting', since: now - 2 * 60_000 }, now), '2m')
})
