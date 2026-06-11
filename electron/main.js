const { app, BrowserWindow, screen } = require('electron')
const path = require('path')
const { clampCount, windowConfigs } = require('./layout')
const { startHealthServer, crashBackoffMs } = require('./health')

// screenId → BrowserWindow, for per-window crash recovery and /health.
const windows = new Map()
// screenId → consecutive renderer crashes, drives recreate backoff.
const crashCounts = new Map()

function createWindow(config) {
  const { screenId, x, y, width, height, fullscreen } = config
  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    fullscreen,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      // Kiosk/signage: allow personalized clips (which carry TTS audio) to
      // autoplay without a user gesture.
      autoplayPolicy: 'no-user-gesture-required',
    },
  })
  windows.set(screenId, win)
  // The kiosk runs fullscreen with no menu bar, so forward renderer console
  // output to the terminal that launched Electron — that's where you'll see the
  // [kiosk] WS/playback logs without needing DevTools.
  win.webContents.on('console-message', (_event, _level, message) => {
    console.log(`[renderer ${screenId}]`, message)
  })

  // T3 inner watchdog layer: one display crashing must not dark-screen the
  // other windows or restart the whole app (launchd handles whole-app death).
  win.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return // normal shutdown, not a crash
    const crashes = (crashCounts.get(screenId) ?? 0) + 1
    crashCounts.set(screenId, crashes)
    const delay = crashBackoffMs(crashes)
    console.log(`[watchdog] renderer ${screenId} gone (${details.reason}) — recreating in ${delay}ms (crash #${crashes})`)
    windows.delete(screenId)
    setTimeout(() => {
      createWindow(config) // replacement first, then drop the dead shell
      if (!win.isDestroyed()) win.destroy()
    }, delay)
  })
  win.webContents.on('did-finish-load', () => {
    crashCounts.delete(screenId) // healthy load resets the backoff
  })
  win.on('unresponsive', () => {
    console.log(`[watchdog] renderer ${screenId} unresponsive — reloading`)
    win.webContents.reload()
  })

  if (process.env.NODE_ENV === 'development') {
    win.loadURL(`http://localhost:5173/?screen_id=${screenId}`)
    // DevTools off by default for the kiosk. Set KIOSK_DEVTOOLS=1 to re-enable while debugging.
    if (process.env.KIOSK_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'), { search: `screen_id=${screenId}` })
  }
}

// Multi-display kiosk: DISPLAY_COUNT windows (default 4, max 10), one
// fullscreen per monitor when enough are attached, else a grid on the
// primary display. Each window gets its identity via ?screen_id=display-<n>.
function createWindows() {
  const count = clampCount(process.env.DISPLAY_COUNT)
  for (const config of windowConfigs(count, screen.getAllDisplays())) {
    createWindow(config)
  }
}

app.whenReady().then(() => {
  createWindows()
  // Health endpoint for the System Health Monitor (P3-C4): per-window status
  // from the main process, so a dead/hung renderer is visible from outside.
  const port = parseInt(process.env.KIOSK_HEALTH_PORT ?? '8003', 10)
  startHealthServer(port, () =>
    [...windows.entries()].map(([screenId, win]) => ({
      screenId,
      alive: !win.isDestroyed() && !win.webContents.isCrashed(),
    }))
  )
})
app.on('window-all-closed', () => app.quit())
