// Single sync loop shared by the launchd runner and the plugin worker (whichever holds the lock).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createOrcaBridge } from './orca-bridge.mjs'
import { createSyncEngine, loadConfig } from './sync.mjs'

const ROOT = process.env.ORCA_TMUX_HOME || join(homedir(), '.orca-tmux')
const LOCK = join(ROOT, 'runner.lock')
const CONTROL_DIR = join(ROOT, 'control')
// Pausing persists across runner restarts (login, crash) until resumed.
const PAUSED = join(ROOT, 'paused')

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

export function lockOwner() {
  try {
    const pid = Number(readFileSync(LOCK, 'utf8'))
    return pid && isAlive(pid) ? pid : null
  } catch {
    return null
  }
}

function tryLock() {
  const owner = lockOwner()
  if (owner && owner !== process.pid) {
    return false
  }
  mkdirSync(ROOT, { recursive: true })
  writeFileSync(LOCK, String(process.pid))
  return true
}

// Commands from the plugin reach whichever process runs the loop through small files.
export function sendControl(action, payload = {}) {
  mkdirSync(CONTROL_DIR, { recursive: true })
  writeFileSync(join(CONTROL_DIR, `${Date.now()}-${process.pid}.json`), JSON.stringify({ action, ...payload }))
}

function drainControl() {
  let names = []
  try {
    names = readdirSync(CONTROL_DIR).sort()
  } catch {
    return []
  }
  const messages = []
  for (const name of names) {
    const path = join(CONTROL_DIR, name)
    try {
      messages.push(JSON.parse(readFileSync(path, 'utf8')))
    } catch {
      // ignore partial writes; removed below
    }
    rmSync(path, { force: true })
  }
  return messages
}

export function startLoop({ cli, env, log, notify }) {
  if (!tryLock()) {
    return null
  }
  const bridge = createOrcaBridge({ env, log })
  const engine = createSyncEngine({ cli, bridge, env, log, notify })
  let stopped = false
  let nextTickAt = 0
  let runningCheckedAt = 0
  let lastProbeAt = 0
  // tmux hooks touch ROOT/trigger when windows, panes or sessions change: sync at once.
  let watcher = null
  try {
    watcher = watch(ROOT, (_event, name) => {
      if (name === 'trigger' || name === null) {
        nextTickAt = 0
      }
    })
  } catch (err) {
    log(`cannot watch ${ROOT}: ${err.message}`)
  }

  const handle = async (message) => {
    switch (message.action) {
      case 'pause':
        writeFileSync(PAUSED, '')
        log('paused')
        return
      case 'resume':
        rmSync(PAUSED, { force: true })
        log('resumed')
        break
      case 'reopen-closed':
        engine.reopenDismissed()
        break
      case 'new-window':
        if (!(await engine.newWindow(message.displayName ?? ''))) {
          void notify('tmux', 'Focus a tmux session card first.')
        }
        break
    }
    nextTickAt = 0
  }

  const run = async () => {
    while (!stopped) {
      if (lockOwner() !== process.pid) {
        log('lost runner lock; stopping')
        break
      }
      for (const message of drainControl()) {
        await handle(message).catch((err) => log(`control ${message.action} failed: ${err.message}`))
      }
      if (!existsSync(PAUSED) && Date.now() >= nextTickAt) {
        nextTickAt = Date.now() + Math.max(2, loadConfig().intervalSec) * 1000
        // `orca status` starts a process: ask at most every 30s while Orca is up.
        let running = Date.now() - runningCheckedAt < 30_000
        if (!running && (running = await cli.isRunning())) {
          runningCheckedAt = Date.now()
        }
        if (running) {
          const tickStart = Date.now()
          const result = await engine.tick().catch((err) => {
            runningCheckedAt = 0
            log(`tick failed: ${err.message}`)
          })
          if (existsSync(join(ROOT, 'timing'))) {
            log(`tick ${Date.now() - tickStart}ms${result?.soon ? ' (follow-up)' : ''}`)
          }
          if (result?.soon) {
            nextTickAt = Math.min(nextTickAt, Date.now() + (result.soonMs ?? 1000)) // a new tab settling: look again soon
          }
        }
      }
      // Once a second between passes: a tab opened or closed in Orca wakes the loop.
      if (!existsSync(PAUSED) && Date.now() - lastProbeAt >= 1000 && nextTickAt - Date.now() > 500) {
        lastProbeAt = Date.now()
        if (await engine.probe().catch(() => false)) {
          nextTickAt = 0
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }
  void run()

  return {
    stop() {
      stopped = true
      watcher?.close()
      bridge.close()
      if (lockOwner() === process.pid) {
        rmSync(LOCK, { force: true })
      }
    }
  }
}
