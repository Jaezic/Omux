// How long since the last keyboard or mouse input on this Mac (macOS HIDIdleTime), in ms; null
// where it cannot be read. One small process, asked every couple of seconds. By full path: launchd's PATH has no /usr/sbin.
import { execFile } from 'node:child_process'

export function userIdleMs() {
  return new Promise((resolve) => {
    execFile('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4', '-r', '-k', 'HIDIdleTime'], { timeout: 2000 }, (err, out) => {
      const ns = !err && /"HIDIdleTime" = (\d+)/.exec(out)?.[1]
      resolve(ns ? Number(BigInt(ns) / 1_000_000n) : null)
    })
  })
}
