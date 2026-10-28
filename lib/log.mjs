// The runner's log (launchd sends stdout to ~/.orca-tmux/runner.log). A message repeated back to
// back is written once, then summed up ("… repeated N times") when another message comes or every
// 10 minutes. Past 1 MB the file is moved to runner.log.1 and started over: launchd holds it open
// for appending, so it is copied and emptied in place rather than renamed.
import { copyFileSync, statSync, truncateSync } from 'node:fs'

const MAX_BYTES = 1024 * 1024
const SUMMARY_MS = 600_000

export function createLog({ path, write = (line) => process.stdout.write(`${line}\n`), now = () => Date.now() } = {}) {
  let last = null
  let repeats = 0
  let since = 0
  let checks = 0

  const stamp = () => new Date(now()).toISOString()
  const flush = () => {
    if (repeats) {
      write(`${stamp()} … repeated ${repeats} times: ${last}`)
    }
    repeats = 0
    since = now()
  }

  function rotate() {
    if (!path || ++checks % 50) {
      return
    }
    try {
      if (statSync(path).size > MAX_BYTES) {
        copyFileSync(path, `${path}.1`)
        truncateSync(path, 0)
      }
    } catch {}
  }

  return (message) => {
    if (message === last) {
      repeats++
      if (now() - since >= SUMMARY_MS) {
        flush()
      }
      return
    }
    flush()
    last = message
    write(`${stamp()} ${message}`)
    rotate()
  }
}
