const { app, BrowserWindow, screen } = require('electron')
const path = require('path')
const { clampCount, windowConfigs } = require('./layout')

function createWindow({ screenId, x, y, width, height, fullscreen }) {
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
  // The kiosk runs fullscreen with no menu bar, so forward renderer console
  // output to the terminal that launched Electron — that's where you'll see the
  // [kiosk] WS/playback logs without needing DevTools.
  win.webContents.on('console-message', (_event, _level, message) => {
    console.log(`[renderer ${screenId}]`, message)
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

app.whenReady().then(createWindows)
app.on('window-all-closed', () => app.quit())
