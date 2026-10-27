#!/usr/bin/env node
// Runner outside Orca: `watch` is the launchd loop, `scan` prints the inventory, `sync` reconciles once.
import { execFile } from 'node:child_process'
import { startLoop } from '../lib/loop.mjs'
import { createOrcaBridge } from '../lib/orca-bridge.mjs'
import { createOrcaCli } from '../lib/orca-cli.mjs'
import { resolveHosts } from '../lib/hosts.mjs'
import { scanHost } from '../lib/scan.mjs'
import { createSyncEngine, loadConfig, windowTitle } from '../lib/sync.mjs'

const [command = 'scan', ...hostArgs] = process.argv.slice(2)
// launchd starts us without a locale; tmux and ssh (SendEnv LANG) need UTF-8 for non-ASCII titles.
const env = {
  ...process.env,
  LANG: process.env.LANG || 'en_US.UTF-8',
  PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin`
}

if (command === 'scan') {
  const hosts = hostArgs.length ? hostArgs : resolveHosts(loadConfig())
  for (const host of hosts) {
    try {
      const scan = await scanHost(host, { env })
      console.log(`▾ ${host}`)
      for (const session of scan.sessions) {
        console.log(`  ▾ ${session.name}`)
        for (const window of session.windows) {
          console.log(`     ${windowTitle(window)}`)
        }
      }
    } catch (err) {
      console.log(`✗ ${host}: ${String(err.stderr || err.message).trim().split('\n').pop()}`)
    }
  }
} else if (command === 'sync') {
  const bridge = createOrcaBridge({ env, log: console.log })
  const engine = createSyncEngine({ cli: createOrcaCli({ env }), bridge, env, log: console.log })
  await engine.tick()
  await engine.settled()
  bridge.close()
} else if (command === 'watch') {
  const log = (message) => console.log(`${new Date().toISOString()} ${message}`)
  const notify = async (title, body) => {
    const quote = (text) => JSON.stringify(String(text))
    execFile('osascript', ['-e', `display notification ${quote(body)} with title ${quote(title)}`], () => {})
  }
  const loop = startLoop({ cli: createOrcaCli({ env }), env, log, notify })
  if (!loop) {
    log('another runner holds the lock; exiting')
    process.exit(0)
  }
  log('watching tmux sessions')
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      loop.stop()
      process.exit(0)
    })
  }
} else {
  console.error('usage: tmux-agents.mjs watch | scan [host...] | sync')
  process.exit(2)
}
