// The title hook on a real tmux server of its own (TMUX_TMPDIR): the trigger fires when an agent
// goes busy or idle, not on every spinner frame.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

process.env.ORCA_TMUX_HOME = mkdtempSync(join(tmpdir(), 'omux-test-'))
const { hookScript } = await import('../lib/sync.mjs')

let hasTmux = true
try {
  execFileSync('tmux', ['-V'])
} catch {
  hasTmux = false
}

test('the title hook fires on busy/idle changes only, and never runs the title as shell', { skip: !hasTmux }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'omux-hook-'))
  const env = { ...process.env, TMUX_TMPDIR: dir, TMUX: '' }
  const tmux = (...args) => execFileSync('tmux', args, { env }).toString().trim()
  const trigger = join(dir, 'trigger')
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  try {
    tmux('new-session', '-d', '-s', 't', 'sleep 30')
    execFileSync('sh', ['-c', hookScript(trigger)], { env })
    const pane = tmux('list-panes', '-t', 't', '-F', '#{pane_id}')
    const fires = []
    for (const title of ['✳ idle', '⠋ work', '⠙ work', '⠹ work', `✳ $(touch ${join(dir, 'pwned')})`, '✳ still idle']) {
      rmSync(trigger, { force: true })
      tmux('select-pane', '-t', pane, '-T', title)
      await wait(150)
      fires.push(existsSync(trigger))
    }
    assert.deepEqual(fires, [true, true, false, false, true, false])
    assert.ok(!existsSync(join(dir, 'pwned')), 'the title is not run by a shell')
  } finally {
    try {
      tmux('kill-server')
    } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
})
