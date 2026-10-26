// Runs on Orca's own Electron binary (ELECTRON_RUN_AS_NODE) and serves runtime RPC calls over
// stdio through the CLI's RuntimeClient, which already knows how to reach the desktop runtime and
// the paired orcad server Orca deploys on each SSH host (encrypted tunnel included).
// argv[2]: <Orca.app>/Contents/Resources/app.asar.unpacked
const path = require('node:path')
const readline = require('node:readline')
const { RuntimeClient } = require(path.join(process.argv[2], 'out', 'cli', 'runtime-client.js'))

const clients = new Map()
function clientFor(environment) {
  const key = environment || ''
  if (!clients.has(key)) {
    clients.set(key, new RuntimeClient(undefined, 30_000, null, environment || null))
  }
  return clients.get(key)
}

const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  try {
    const response = await clientFor(request.env).call(request.method, request.params)
    reply({ id: request.id, ok: true, result: response?.result ?? response })
  } catch (err) {
    reply({ id: request.id, ok: false, error: err?.message ?? String(err) })
  }
})
