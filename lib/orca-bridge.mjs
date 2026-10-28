// Long-lived child process (lib/bridge.cjs on Orca's Electron) for runtime RPC calls, locally
// (env null) or on a host's orcad environment (env = environment name or id).
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), 'bridge.cjs')

function resolveOrcaApp() {
  const m = process.execPath.match(/^(.*?\.app)\/Contents\/MacOS\//)
  return [m?.[1], '/Applications/Orca.app'].find((app) => app && existsSync(join(app, 'Contents', 'MacOS', 'Orca')))
}

export function createOrcaBridge({ env = process.env, log = () => {} } = {}) {
  const app = resolveOrcaApp()
  if (!app) {
    throw new Error('Orca.app not found')
  }
  let child = null
  let nextId = 1
  let timeouts = 0 // in a row: a wedged child answers nothing and is replaced
  const waiting = new Map()

  function start() {
    child = spawn(join(app, 'Contents', 'MacOS', 'Orca'), [BRIDGE, join(app, 'Contents', 'Resources', 'app.asar.unpacked')], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    createInterface({ input: child.stdout }).on('line', (line) => {
      let message
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      const entry = waiting.get(message.id)
      if (!entry) {
        return
      }
      waiting.delete(message.id)
      clearTimeout(entry.timer)
      timeouts = 0
      message.ok ? entry.resolve(message.result) : entry.reject(new Error(message.error))
    })
    child.stderr.on('data', () => {})
    child.on('exit', (code) => {
      log(`orca bridge exited (${code})`)
      child = null
      for (const [id, entry] of waiting) {
        clearTimeout(entry.timer)
        entry.reject(new Error('orca bridge exited'))
        waiting.delete(id)
      }
    })
  }

  return {
    call(environment, method, params) {
      if (!child) {
        start()
      }
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id)
          reject(new Error(`${method} timed out`))
          if (++timeouts >= 3 && child) {
            log('orca bridge answers nothing; restarting it')
            timeouts = 0
            child.kill()
          }
        }, 40_000)
        waiting.set(id, { resolve, reject, timer })
        child.stdin.write(`${JSON.stringify({ id, env: environment ?? null, method, params })}\n`)
      })
    },
    close() {
      child?.kill()
    }
  }
}
