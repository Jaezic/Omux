// Host list: local + concrete Host aliases from ~/.ssh/config (follows Include).
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, basename } from 'node:path'

function expandInclude(pattern) {
  let path = pattern.replace(/^~(?=\/)/, homedir())
  if (!isAbsolute(path)) {
    path = join(homedir(), '.ssh', path)
  }
  if (!/[*?]/.test(basename(path))) {
    return [path]
  }
  const dir = dirname(path)
  const re = new RegExp(
    '^' + basename(path).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
  )
  try {
    return readdirSync(dir)
      .filter((name) => re.test(name))
      .map((name) => join(dir, name))
  } catch {
    return []
  }
}

function collectHosts(file, out, seen) {
  if (seen.has(file) || !existsSync(file)) {
    return
  }
  seen.add(file)
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim()
    const m = line.match(/^(\w+)\s*=?\s*(.+)$/)
    if (!m) {
      continue
    }
    const key = m[1].toLowerCase()
    if (key === 'include') {
      for (const pattern of m[2].split(/\s+/)) {
        for (const path of expandInclude(pattern)) {
          collectHosts(path, out, seen)
        }
      }
    } else if (key === 'host') {
      for (const alias of m[2].split(/\s+/)) {
        if (!/[*?!]/.test(alias)) {
          out.add(alias)
        }
      }
    }
  }
}

export function sshConfigHosts() {
  const out = new Set()
  collectHosts(join(homedir(), '.ssh', 'config'), out, new Set())
  return [...out]
}

export function resolveHosts(config, orcaConnected = new Set()) {
  const listed = Array.isArray(config.hosts)
    ? config.hosts
    : config.hosts === 'ssh-config'
      ? sshConfigHosts()
      : [...orcaConnected]
  const exclude = new Set(config.exclude ?? [])
  return ['local', ...listed.filter((h) => h !== 'local' && !exclude.has(h))]
}
