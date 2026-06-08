import { StrictMode } from 'react'
import { render, act } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import App from '../App'

interface MockWSInstance {
  onopen: (() => void) | null
  onclose: (() => void) | null
  onmessage: ((e: { data: string }) => void) | null
  close: ReturnType<typeof vi.fn>
  simulateOpen: () => void
  simulateClose: () => void
  simulateMessage: (data: object) => void
}

let mockWS: MockWSInstance
let wsInstances: MockWSInstance[] = []
const MockWebSocket = vi.fn(() => {
  mockWS = {
    onopen: null, onclose: null, onmessage: null,
    close: vi.fn(),
    simulateOpen() { this.onopen?.() },
    simulateClose() { this.onclose?.() },
    simulateMessage(data) { this.onmessage?.({ data: JSON.stringify(data) }) },
  }
  wsInstances.push(mockWS)
  return mockWS
})

beforeEach(() => {
  vi.stubGlobal('WebSocket', MockWebSocket)
  // Default: empty playlist → kiosk keeps its single default video (keeps the
  // other tests off the network). The rotation test overrides this.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ videos: [] }) }))
  MockWebSocket.mockClear()
  wsInstances = []
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    writable: true,
    value: vi.fn().mockResolvedValue(undefined),
  })
  Object.defineProperty(HTMLMediaElement.prototype, 'load', {
    writable: true,
    value: vi.fn(),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('WebSocket reconnect backoff', () => {
  it('reconnects after 1s on first disconnect', async () => {
    vi.useFakeTimers()
    render(<App />)
    expect(MockWebSocket).toHaveBeenCalledTimes(1)

    await act(async () => { mockWS.simulateClose() })
    await act(async () => { vi.advanceTimersByTime(1000) })

    expect(MockWebSocket).toHaveBeenCalledTimes(2)
  })

  it('doubles retry delay on each disconnect', async () => {
    vi.useFakeTimers()
    render(<App />)

    // Close 1 → retry at 1s
    await act(async () => { mockWS.simulateClose() })
    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(MockWebSocket).toHaveBeenCalledTimes(2)

    // Close 2 → retry at 2s
    await act(async () => { mockWS.simulateClose() })
    await act(async () => { vi.advanceTimersByTime(1999) })
    expect(MockWebSocket).toHaveBeenCalledTimes(2)  // not yet
    await act(async () => { vi.advanceTimersByTime(1) })
    expect(MockWebSocket).toHaveBeenCalledTimes(3)
  })

  it('plays fallback video after 5 failed attempts', async () => {
    vi.useFakeTimers()
    vi.stubEnv('VITE_FALLBACK_VIDEO_PATH', '/local/fallback.mp4')

    const { container } = render(<App />)
    const video = container.querySelector('video')!

    let delay = 1000
    for (let i = 0; i < 5; i++) {
      await act(async () => { mockWS.simulateClose() })
      await act(async () => { vi.advanceTimersByTime(delay) })
      delay = Math.min(delay * 2, 30000)
    }

    expect(video.src).toContain('fallback.mp4')
  })

  it('restores standard video on successful reconnect after fallback', async () => {
    vi.useFakeTimers()
    vi.stubEnv('VITE_FALLBACK_VIDEO_PATH', '/local/fallback.mp4')
    vi.stubEnv('VITE_STANDARD_VIDEO_URL', 'http://localhost:8002/assets/standard.mp4')

    const { container } = render(<App />)
    const video = container.querySelector('video')!

    let delay = 1000
    for (let i = 0; i < 5; i++) {
      await act(async () => { mockWS.simulateClose() })
      await act(async () => { vi.advanceTimersByTime(delay) })
      delay = Math.min(delay * 2, 30000)
    }

    await act(async () => { mockWS.simulateOpen() })
    await act(async () => { vi.advanceTimersByTime(600) })

    expect(video.src).toContain('standard.mp4')
  })
})

describe('connection lifecycle', () => {
  it('does not reconnect after the component unmounts (intentional close)', async () => {
    vi.useFakeTimers()
    const { unmount } = render(<App />)
    expect(MockWebSocket).toHaveBeenCalledTimes(1)

    // A real WebSocket fires onclose when closed; the unmount cleanup closes it.
    mockWS.close.mockImplementation(() => mockWS.onclose?.())
    unmount()
    await act(async () => { vi.advanceTimersByTime(5000) })

    expect(MockWebSocket).toHaveBeenCalledTimes(1) // no reconnect spawned by the cleanup close
  })

  it('rotates sequentially through the fetched playlist on ended', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ videos: ['http://x/a.mp4', 'http://x/b.mp4', 'http://x/c.mp4'] }),
    }))
    const { container } = render(<App />)
    const video = container.querySelector('video')!

    await act(async () => { await vi.runAllTimersAsync() }) // fetch resolves + fade timer
    expect(video.src).toContain('a.mp4')

    await act(async () => { video.dispatchEvent(new Event('ended')); await vi.runAllTimersAsync() })
    expect(video.src).toContain('b.mp4')

    await act(async () => { video.dispatchEvent(new Event('ended')); await vi.runAllTimersAsync() })
    expect(video.src).toContain('c.mp4')

    await act(async () => { video.dispatchEvent(new Event('ended')); await vi.runAllTimersAsync() })
    expect(video.src).toContain('a.mp4') // wraps around
  })

  it('picks up a newly added video on a later refresh without restart', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ videos: ['http://x/a.mp4'] }) })
      .mockResolvedValue({ json: async () => ({ videos: ['http://x/a.mp4', 'http://x/b.mp4'] }) })
    vi.stubGlobal('fetch', fetchMock)

    const { container } = render(<App />)
    const video = container.querySelector('video')!
    await act(async () => { await vi.runAllTimersAsync() })
    expect(video.src).toContain('a.mp4') // single-item list at startup

    // a video gets dropped in; the kiosk re-fetches on rotation and picks it up
    await act(async () => { video.dispatchEvent(new Event('ended')); await vi.runAllTimersAsync() })
    await act(async () => { video.dispatchEvent(new Event('ended')); await vi.runAllTimersAsync() })
    expect(video.src).toContain('b.mp4') // new entry now in rotation, no restart
  })

  it('a rapid second play cancels the first pending load (one load)', async () => {
    vi.useFakeTimers()
    render(<App />)
    await act(async () => { mockWS.simulateOpen() })
    await act(async () => { vi.advanceTimersByTime(600) }) // flush the initial standard load

    const loadSpy = HTMLMediaElement.prototype.load as unknown as ReturnType<typeof vi.fn>
    loadSpy.mockClear()

    // Two play messages inside the 500ms fade window must not both load() —
    // a second load() interrupting the first play() throws DOMException.
    await act(async () => {
      mockWS.simulateMessage({ type: 'play', video_url: 'http://x/first.mp4' })
      mockWS.simulateMessage({ type: 'play', video_url: 'http://x/second.mp4' })
    })
    await act(async () => { vi.advanceTimersByTime(600) })

    expect(loadSpy).toHaveBeenCalledTimes(1)
  })

  it('keeps a single live socket under StrictMode double-mount (no zombie)', async () => {
    vi.useFakeTimers()
    render(<StrictMode><App /></StrictMode>)
    // StrictMode double-invokes the effect (mount → cleanup → mount): the first
    // socket is cleaned up, the second is the live one.
    expect(wsInstances.length).toBe(2)

    // The first (cleaned-up) socket fires its onclose asynchronously, AFTER the
    // remount. A shared flag would have been reset by the remount and reconnect
    // (spawning a 3rd zombie socket); a per-connection flag must not.
    await act(async () => { wsInstances[0].onclose?.() })
    await act(async () => { vi.advanceTimersByTime(5000) })

    expect(wsInstances.length).toBe(2) // no extra reconnect
  })

  it('plays the personalized clip on a play message', async () => {
    vi.useFakeTimers()
    const { container } = render(<App />)
    const video = container.querySelector('video')!

    await act(async () => { mockWS.simulateOpen() })
    await act(async () => {
      mockWS.simulateMessage({ type: 'play', video_url: 'http://localhost:8002/media/abc.mp4' })
    })
    await act(async () => { vi.advanceTimersByTime(600) })

    expect(video.src).toContain('/media/abc.mp4')
    expect(video.loop).toBe(false)
  })
})
