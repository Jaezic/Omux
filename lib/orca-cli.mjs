// Thin wrapper over the public `orca` CLI (stable across app updates, unlike internal APIs).
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Written by Orca while it runs (runtimeId, pid, ...; it also holds an auth token, never read here).
const RUNTIME_FILE = join(homedir(), 'Library', 'Application Support', 'orca', 'orca-runtime.json')

// The running Orca's runtime id, or null when Orca is not running. A file read, not a CLI call, so it
// can be asked every pass: an Orca restart is noticed at once.
export function readRuntimeId(file = RUNTIME_FILE) {
  try {
    const { runtimeId, pid } = JSON.parse(readFileSync(file, 'utf8'))
    process.kill(pid, 0)
    return typeof runtimeId === 'string' ? runtimeId : null
  } catch {
    return null
  }
}

export function resolveOrcaCli() {
  if (process.env.ORCA_CLI) {
    return process.env.ORCA_CLI
  }
  // The plugin worker runs on Orca's own Electron binary; its bundle ships the CLI.
  const m = process.execPath.match(/^(.*?\.app)\/Contents\/MacOS\//)
  const candidates = [
    m && `${m[1]}/Contents/Resources/bin/orca`,
    '/Applications/Orca.app/Contents/Resources/bin/orca'
  ].filter(Boolean)
  return candidates.find((path) => existsSync(path)) ?? 'orca'
}

export function createOrcaCli({ env, bin = resolveOrcaCli() } = {}) {
  const call = (args) =>
    new Promise((resolve, reject) => {
      execFile(bin, [...args, '--json'], { env, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        let parsed = null
        try {
          parsed = JSON.parse(stdout)
        } catch {
          // fall through
        }
        if (parsed?.ok) {
          resolve(parsed.result)
        } else {
          reject(new Error(parsed?.error?.message ?? err?.message ?? `orca ${args[0]} failed`))
        }
      })
    })

  return {
    runtimeId: () => readRuntimeId(),
    status: () => call(['status']),
    isRunning: () => call(['status']).then((r) => r.runtime?.reachable === true, () => false),
    listWorktrees: () => call(['worktree', 'list', '--limit', '1000']).then((r) => r.worktrees ?? []),
    addRepo: (path) => call(['repo', 'add', '--path', path]),
    setWorktreeName: (path, name) =>
      call(['worktree', 'set', '--worktree', `path:${path}`, '--display-name', name]),
    setParent: (path, parentPath) =>
      call(['worktree', 'set', '--worktree', `path:${path}`, '--parent-worktree', `path:${parentPath}`]),
    listTerminals: (path) =>
      call(['terminal', 'list', '--worktree', `path:${path}`]).then((r) => r.terminals ?? []),
    createTerminal: (path, title, command) =>
      call(['terminal', 'create', '--worktree', `path:${path}`, '--title', title, '--command', command]).then(
        (r) => r.terminal
      ),
    listHosts: () => call(['host', 'list']).then((r) => r.hosts ?? []),
    listEnvironments: () => call(['environment', 'list']).then((r) => r.environments ?? []),
    sendText: (handle, text) => call(['terminal', 'send', '--terminal', handle, '--text', text, '--enter']),
    renameTerminal: (handle, title) => call(['terminal', 'rename', '--terminal', handle, '--title', title]),
    closeTerminal: (handle) => call(['terminal', 'close', '--terminal', handle, '--tab'])
  }
}
