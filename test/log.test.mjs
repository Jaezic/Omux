import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createLog } from '../lib/log.mjs'

test('a message repeated back to back is written once, then summed up', () => {
  const lines = []
  let t = 0
  const log = createLog({ write: (l) => lines.push(l.slice(25)), now: () => t })
  log('sync failed')
  log('sync failed')
  log('sync failed')
  log('connected')
  assert.deepEqual(lines, ['sync failed', '… repeated 2 times: sync failed', 'connected'])
  lines.length = 0
  log('connected')
  t += 600_000
  log('connected')
  assert.deepEqual(lines, ['… repeated 2 times: connected'], 'a long run is summed up every 10 minutes')
})

test('past 1 MB the log moves to runner.log.1 and starts over', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omux-log-'))
  const path = join(dir, 'runner.log')
  writeFileSync(path, 'x'.repeat(1024 * 1024 + 1))
  const log = createLog({ path, write: () => {} })
  for (let i = 0; i < 50; i++) log(`m${i}`)
  assert.equal(readFileSync(path, 'utf8'), '')
  assert.ok(existsSync(`${path}.1`))
})
