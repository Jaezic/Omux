// Orca plugin worker: in-app commands and keybindings for the tmux mirror.
// The sync loop normally runs in the launchd runner (bin/install.sh); if that is not
// running, the worker runs the loop itself while Orca is open.
import { execFileSync } from 'node:child_process'
import { createOrcaCli } from './lib/orca-cli.mjs'
import { lockOwner, sendControl, startLoop } from './lib/loop.mjs'

// The worker env is an allowlist without the user's shell PATH or ssh-agent socket.
function buildEnv() {
  const env = { ...process.env, LANG: process.env.LANG || 'en_US.UTF-8' }
  env.PATH = [env.PATH, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':')
  if (!env.SSH_AUTH_SOCK && process.platform === 'darwin') {
    try {
      const sock = execFileSync('launchctl', ['getenv', 'SSH_AUTH_SOCK'], { encoding: 'utf8' }).trim()
      if (sock) {
        env.SSH_AUTH_SOCK = sock
      }
    } catch {
      // keys in ~/.ssh or IdentityAgent in ssh config still work
    }
  }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

let loop = null

export default async function activate(orca) {
  const env = buildEnv()
  const notify = (title, body) => orca.host.call('notifications.show', { title, body }).catch(() => {})
  const ensureLoop = () => {
    if (!loop && !lockOwner()) {
      loop = startLoop({ cli: createOrcaCli({ env }), env, log: (m) => orca.log(m), notify })
    }
  }
  const control = (action, payload) => {
    ensureLoop()
    sendControl(action, payload)
  }

  orca.commands.register('sync-now', () => control('sync-now'))
  orca.commands.register('reopen-closed', () => control('reopen-closed'))
  orca.commands.register('pause', () => control('pause'))
  orca.commands.register('resume', () => control('resume'))
  orca.commands.register('new-window', async () => {
    const context = await orca.host.call('workspace.readContext').catch(() => null)
    control('new-window', { displayName: context?.displayName ?? '' })
  })
  // Subscribing wakes the worker on Orca agent activity so the fallback loop can start.
  orca.events.on('agent.status.changed', () => ensureLoop())

  // Host calls count as activity; without them Orca reaps the worker after 5 idle minutes.
  setInterval(() => {
    ensureLoop()
    orca.host.call('storage.keys').catch(() => {})
  }, 60_000)
  ensureLoop()
}

export function deactivate() {
  loop?.stop()
  loop = null
}
