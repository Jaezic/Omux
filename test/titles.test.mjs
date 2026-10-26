import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ORCA_TMUX_HOME = mkdtempSync(join(tmpdir(), 'omux-test-'))
const { attachCommand } = await import('../lib/attach-command.mjs')
const { idleAge, orcaTitle, windowTitle } = await import('../lib/sync.mjs')

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
