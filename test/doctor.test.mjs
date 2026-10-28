import assert from 'node:assert/strict'
import { test } from 'node:test'
import { doctorReport } from '../lib/doctor.mjs'

const now = 1_800_000_000_000
const base = {
  now,
  runnerPid: 123,
  orcaRunning: true,
  tmuxSessions: 2,
  hooks: { windows: true, titles: true },
  recentFailures: 0,
  health: { at: now - 5_000, hosts: { local: { okAt: now - 2_000 }, spark: { okAt: now - 2_000 } } }
}

test('all good: ok, one line per check and host', () => {
  const { ok, lines } = doctorReport(base)
  assert.equal(ok, true)
  assert.ok(lines.every((l) => l.startsWith('✓')))
  assert.ok(lines.some((l) => l.includes('spark: last good scan 2s ago')))
})

test('a host not scanned for minutes is flagged with what is failing', () => {
  const health = { at: now - 5_000, hosts: { local: { okAt: now - 2_000 }, spark: { okAt: now - 21 * 3_600_000, error: 'relay helper starting' } } }
  const { ok, lines } = doctorReport({ ...base, health })
  assert.equal(ok, false)
  assert.ok(lines.some((l) => l.startsWith('✗ spark: last good scan 21h ago, failing: relay helper starting')))
})

test('a stopped runner or missing hooks are flagged with the fix', () => {
  const { ok, lines } = doctorReport({ ...base, runnerPid: null, hooks: { windows: true, titles: false } })
  assert.equal(ok, false)
  assert.ok(lines.some((l) => l.includes('runner not running') && l.includes('launchctl kickstart')))
  assert.ok(lines.some((l) => l.includes('agent busy/idle missing')))
})
