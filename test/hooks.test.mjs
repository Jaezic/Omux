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
    for (const title of ['myhost', '✳ idle', '⠋ work', '⠙ work', '⠹ work', `✳ $(touch ${join(dir, 'pwned')})`, '✳ still idle', 'task | proj']) {
      rmSync(trigger, { force: true })
      tmux('select-pane', '-t', pane, '-T', title)
      await wait(150)
      fires.push(existsSync(trigger))
    }
    // A claude starting (host name → "✳ …") fires too; codex going idle ("task | proj") as well.
    assert.deepEqual(fires, [true, true, true, false, false, true, false, true])
    assert.ok(!existsSync(join(dir, 'pwned')), 'the title is not run by a shell')
  } finally {
    try {
      tmux('kill-server')
    } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the scan script finds a working agent on a real tmux server', { skip: !hasTmux }, async () => {
  const { SCAN_SCRIPT, parseScan } = await import('../lib/scan.mjs')
  const { symlinkSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'omux-scan-'))
  const env = { ...process.env, TMUX_TMPDIR: dir, TMUX: '', HOME: dir }
  const tmux = (...args) => execFileSync('tmux', args, { env }).toString().trim()
  // A stand-in agent: a process named "claude" showing claude's working line.
  const agent = join(dir, 'claude')
  symlinkSync('/bin/sleep', agent) // a copied system binary is killed on macOS; a link runs
  try {
    tmux('new-session', '-d', '-s', 's', '-x', '100', '-y', '20', `printf '✻ Thinking… (3s · esc to interrupt)\\n'; exec ${agent} 30`)
    tmux('split-window', '-d', '-t', 's', 'sleep 30')
    await new Promise((r) => setTimeout(r, 300))
    const scan = parseScan('local', execFileSync('sh', ['-c', SCAN_SCRIPT], { env }).toString())
    const panes = scan.sessions.flatMap((s) => s.windows.flatMap((w) => w.panes))
    assert.deepEqual(panes.map((p) => [p.agent, p.state]).sort(), [['claude', 'working'], [null, null]].sort())
  } finally {
    try {
      tmux('kill-server')
    } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
})
