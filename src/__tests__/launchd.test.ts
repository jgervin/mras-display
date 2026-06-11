// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const plist = () =>
  readFileSync(join(__dirname, '../../launchd/com.mras.kiosk.plist'), 'utf8')

describe('launchd supervisor plist', () => {
  it('keeps the kiosk alive and starts it at load', () => {
    const xml = plist()
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/)
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
  })

  it('launches the real Electron binary (launchd has no node on PATH)', () => {
    const xml = plist()
    expect(xml).toContain('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    expect(xml).not.toContain('node_modules/.bin/electron') // env-node shim breaks under launchd
    expect(xml).toContain('<key>Label</key>')
    expect(xml).toContain('com.mras.kiosk')
  })
})
