const { app, BrowserWindow } = require('electron')
const path = require('path')

function createWindow() {
  const win = new BrowserWindow({
    fullscreen: true,
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
    console.log('[renderer]', message)
  })

  if (process.env.NODE_ENV === 'development') {
    win.loadURL('http://localhost:5173')
    // DevTools off by default for the kiosk. Set KIOSK_DEVTOOLS=1 to re-enable while debugging.
    if (process.env.KIOSK_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => app.quit())
