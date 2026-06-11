// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
// @ts-expect-error CJS module; declarations not needed for the test runner
import { healthPayload, startHealthServer, crashBackoffMs } from '../../electron/health.js'

let server: { close: () => void; address: () => { port: number } } | undefined

afterEach(() => {
  server?.close()
  server = undefined
})

describe('healthPayload', () => {
  it('reports ok when every window is alive', () => {
    const p = healthPayload([
      { screenId: 'display-1', alive: true },
      { screenId: 'display-2', alive: true },
    ])
    expect(p.status).toBe('ok')
    expect(p.windows).toHaveLength(2)
  })

  it('reports degraded when any window is dead', () => {
    const p = healthPayload([
      { screenId: 'display-1', alive: true },
      { screenId: 'display-2', alive: false },
    ])
    expect(p.status).toBe('degraded')
  })

  it('reports degraded when no windows exist', () => {
    expect(healthPayload([]).status).toBe('degraded')
  })
})

describe('startHealthServer', () => {
  it('serves the payload as JSON on /health', async () => {
    server = startHealthServer(0, () => [{ screenId: 'display-1', alive: true }])
    const { port } = server!.address()
    const res = await fetch(`http://127.0.0.1:${port}/health`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
    expect(body.windows).toEqual([{ screenId: 'display-1', alive: true }])
  })

  it('404s any other path', async () => {
    server = startHealthServer(0, () => [])
    const { port } = server!.address()
    const res = await fetch(`http://127.0.0.1:${port}/other`)
    expect(res.status).toBe(404)
  })

  it('a port conflict must not crash the process (health is best-effort)', async () => {
    server = startHealthServer(0, () => [])
    const { port } = server!.address()
    const second = startHealthServer(port, () => []) // EADDRINUSE
    await new Promise((r) => setTimeout(r, 50))      // error event is async
    second.close()
    // surviving to this assertion = the error was handled, not thrown
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200)
  })
})

describe('crashBackoffMs', () => {
  it('backs off exponentially and caps, so an instant-crashing renderer cannot spin hot', () => {
    expect(crashBackoffMs(1)).toBe(1000)
    expect(crashBackoffMs(2)).toBe(2000)
    expect(crashBackoffMs(3)).toBe(4000)
    expect(crashBackoffMs(10)).toBe(30000) // cap
  })
})
