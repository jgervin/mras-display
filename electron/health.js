// Kiosk health endpoint (T3 watchdog). The MAIN process serves per-window
// status so the System Health Monitor (P3-C4) can detect a dark or degraded
// screen. Pure node http — no Electron imports, unit-tested in
// src/__tests__/health.test.ts.
const http = require('http')

// entries: [{ screenId, alive }]
function healthPayload(entries) {
  const allAlive = entries.length > 0 && entries.every((w) => w.alive)
  return {
    status: allAlive ? 'ok' : 'degraded',
    windows: entries,
    ts: new Date().toISOString(),
  }
}

function startHealthServer(port, getEntries) {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(healthPayload(getEntries())))
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  // Health is best-effort: a port conflict (EADDRINUSE — e.g. a second kiosk
  // instance) must degrade monitoring, never crash the kiosk it monitors.
  server.on('error', (err) => {
    console.error('[health] server error:', err.message)
  })
  server.listen(port)
  return server
}

// Delay before recreating a crashed renderer window: 1s, 2s, 4s … capped at
// 30s, so a renderer that dies instantly every time (bad GPU, broken bundle)
// can't fork replacement processes in a hot loop.
function crashBackoffMs(consecutiveCrashes) {
  return Math.min(1000 * 2 ** (consecutiveCrashes - 1), 30000)
}

module.exports = { healthPayload, startHealthServer, crashBackoffMs }
