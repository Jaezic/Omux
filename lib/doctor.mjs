// `tmux-agents doctor`: one look at whether the mirror is healthy. The runner leaves health.json
// (per host: last good scan, what is failing) every 10s; the rest is checked here.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const STUCK_MS = 180_000

const ago = (ms) => (ms < 90_000 ? `${Math.round(ms / 1000)}s` : ms < 5_400_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`)

// facts: { now, runnerPid, health ({ at, hosts }), orcaRunning, hooks ({ windows, titles }), tmuxSessions,
// recentFailures (log lines with "failed" in the last 10 minutes) }. Returns { ok, lines }.
export function doctorReport(facts) {
  const { now } = facts
  const lines = []
  let ok = true
  const check = (good, text, hint = '') => {
    ok &&= good
    lines.push(`${good ? '✓' : '✗'} ${text}${!good && hint ? `\n    → ${hint}` : ''}`)
  }

  check(Boolean(facts.runnerPid), facts.runnerPid ? `runner running (pid ${facts.runnerPid})` : 'runner not running', 'launchctl kickstart -k gui/$(id -u)/com.omux.runner')
  check(facts.orcaRunning, facts.orcaRunning ? 'Orca running' : 'Orca not running', 'open Orca')
  check(facts.tmuxSessions !== null, facts.tmuxSessions === null ? 'local tmux not reachable' : `local tmux: ${facts.tmuxSessions} sessions`)
  check(facts.hooks.windows && facts.hooks.titles, `tmux hooks: windows ${facts.hooks.windows ? 'on' : 'missing'}, agent busy/idle ${facts.hooks.titles ? 'on' : 'missing'}`, 'restart the runner (hooks are set on its first pass)')

  const health = facts.health
  const fresh = health && now - health.at < 60_000
  check(Boolean(fresh), health ? `health written ${ago(now - health.at)} ago` : 'no health file yet', 'the runner writes it every 10s while Orca runs')
  for (const [host, h] of Object.entries(health?.hosts ?? {})) {
    const since = h.okAt ? now - h.okAt : null
    const good = since !== null && since < STUCK_MS
    const detail = [h.okAt ? `last good scan ${ago(since)} ago` : 'never scanned', h.error && `failing: ${h.error}`].filter(Boolean).join(', ')
    check(good, `${host}: ${detail}`, host === 'local' ? 'check tmux and runner.log' : 'is the host connected in Orca? see runner.log')
    if (h.writeError && now - h.writeError.at < 600_000) {
      lines.push(`! ${host}: tmux writes failed ${ago(now - h.writeError.at)} ago (${h.writeError.message})`)
    }
  }
  if (facts.recentFailures > 0) {
    lines.push(`! ${facts.recentFailures} failures in runner.log in the last 10 minutes`)
  }
  return { ok, lines }
}

// Gathers the facts on this Mac (read-only) for doctorReport.
export function gatherFacts({ root, runnerPid, orcaRunning, env }) {
  const now = Date.now()
  let health = null
  try {
    health = JSON.parse(readFileSync(join(root, 'health.json'), 'utf8'))
  } catch {}
  const tmux = (...args) => {
    try {
      return execFileSync('tmux', args, { env, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    } catch {
      return null
    }
  }
  const sessions = tmux('list-sessions', '-F', '#S')
  const hooks = tmux('show-hooks', '-g') ?? ''
  const titleHook = tmux('show-hooks', '-g', 'pane-title-changed') ?? ''
  let recentFailures = 0
  try {
    const cutoff = new Date(now - 600_000).toISOString()
    recentFailures = readFileSync(join(root, 'runner.log'), 'utf8')
      .split('\n')
      .filter((l) => l.slice(0, 24) > cutoff && / failed|timed out/.test(l)).length
  } catch {}
  return {
    now,
    runnerPid,
    orcaRunning,
    health,
    tmuxSessions: sessions === null ? null : sessions.split('\n').filter((s) => s && !/^orca-[wp]\d+$/.test(s)).length,
    hooks: { windows: hooks.includes('after-new-window[77]'), titles: titleHook.includes('[77]') },
    recentFailures
  }
}
