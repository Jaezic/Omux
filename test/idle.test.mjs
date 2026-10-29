import assert from 'node:assert/strict'
import { test } from 'node:test'
import { userIdleMs } from '../lib/idle.mjs'

test('idle time is a count of ms on macOS, null elsewhere', async () => {
  const ms = await userIdleMs()
  if (process.platform === 'darwin') {
    assert.ok(Number.isInteger(ms) && ms >= 0)
  } else {
    assert.equal(ms, null)
  }
})

test('idle time reads without /usr/sbin on PATH (as under launchd)', async () => {
  const path = process.env.PATH
  process.env.PATH = '/usr/bin:/bin'
  try {
    const ms = await userIdleMs()
    assert.equal(ms === null, process.platform !== 'darwin')
  } finally {
    process.env.PATH = path
  }
})
