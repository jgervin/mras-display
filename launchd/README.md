# Kiosk supervisor (macOS launchd)

`com.mras.kiosk.plist` keeps the always-on kiosk running: launchd relaunches
the Electron app if it crashes or is killed (`KeepAlive`), and starts it at
login (`RunAtLoad`). Production mode plays the built bundle — run
`npm run build` in `/Users/jn/code/mras-display` first.

```bash
# install + start
cp /Users/jn/code/mras-display/launchd/com.mras.kiosk.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.mras.kiosk.plist

# stop + remove (also stops the relaunch loop)
launchctl unload ~/Library/LaunchAgents/com.mras.kiosk.plist
rm ~/Library/LaunchAgents/com.mras.kiosk.plist
```

Logs land in `/tmp/mras-kiosk.log` / `/tmp/mras-kiosk.err`.

Inside the app a second recovery layer handles single-window failures
without restarting the whole kiosk: a crashed renderer
(`render-process-gone`) gets its window recreated with exponential
backoff (1s → 30s cap, reset on a healthy load — so an instantly
re-crashing renderer can't spin), a hung renderer (`unresponsive`) is
reloaded. Per-window status is served by the main process at
`http://localhost:8003/health` (`KIOSK_HEALTH_PORT` to change); a port
conflict degrades monitoring but never kills the kiosk.

Linux/Docker equivalent (when the kiosk is ever containerized):
`restart: unless-stopped` on the compose service.

Note: paths are absolute for this rig (`/Users/jn/code/mras-display`) —
edit the plist when deploying to a different machine.
