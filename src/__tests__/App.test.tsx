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
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
    writable: true,
    value: vi.fn(),
  })
  // Per-element volume backing (jsdom's volume is finicky); allows ramp assertions.
  const volStore = new WeakMap<HTMLMediaElement, number>()
  Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
    configurable: true,
    get() { return volStore.get(this) ?? 1 },
    set(v: number) { volStore.set(this, v) },
  })
})

// The visible ("front") video is the one currently at full opacity.
function activeVideo(container: HTMLElement): HTMLVideoElement {
  const vids = Array.from(container.querySelectorAll('video')) as HTMLVideoElement[]
  return vids.find((v) => v.style.opacity === '1') ?? vids[0]
}

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

    let delay = 1000
    for (let i = 0; i < 5; i++) {
      await act(async () => { mockWS.simulateClose() })
      await act(async () => { vi.advanceTimersByTime(delay) })
      delay = Math.min(delay * 2, 30000)
    }
    await act(async () => { await vi.runAllTimersAsync() })

    expect(activeVideo(container).src).toContain('fallback.mp4')
  })

  it('restores standard video on successful reconnect after fallback', async () => {
    vi.useFakeTimers()
    vi.stubEnv('VITE_FALLBACK_VIDEO_PATH', '/local/fallback.mp4')
    vi.stubEnv('VITE_STANDARD_VIDEO_URL', 'http://localhost:8002/assets/standard.mp4')

    const { container } = render(<App />)

    let delay = 1000
    for (let i = 0; i < 5; i++) {
      await act(async () => { mockWS.simulateClose() })
      await act(async () => { vi.advanceTimersByTime(delay) })
      delay = Math.min(delay * 2, 30000)
    }

    await act(async () => { mockWS.simulateOpen() })
    await act(async () => { await vi.runAllTimersAsync() })

    expect(activeVideo(container).src).toContain('standard.mp4')
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

    await act(async () => { await vi.runAllTimersAsync() }) // fetch resolves + fade timer
    expect(activeVideo(container).src).toContain('a.mp4')

    await act(async () => { activeVideo(container).dispatchEvent(new Event('ended')); await vi.runAllTimersAsync() })
    expect(activeVideo(container).src).toContain('b.mp4')

    await act(async () => { activeVideo(container).dispatchEvent(new Event('ended')); await vi.runAllTimersAsync() })
    expect(activeVideo(container).src).toContain('c.mp4')

    await act(async () => { activeVideo(container).dispatchEvent(new Event('ended')); await vi.runAllTimersAsync() })
    expect(activeVideo(container).src).toContain('a.mp4') // wraps around
  })

  it('picks up a newly added video on a later refresh without restart', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ json: async () => ({ videos: ['http://x/a.mp4'] }) })
      .mockResolvedValue({ json: async () => ({ videos: ['http://x/a.mp4', 'http://x/b.mp4'] }) })
    vi.stubGlobal('fetch', fetchMock)

    const { container } = render(<App />)
    await act(async () => { await vi.runAllTimersAsync() })
    expect(activeVideo(container).src).toContain('a.mp4') // single-item list at startup

    // a video gets dropped in; the kiosk re-fetches on rotation and picks it up
    await act(async () => { activeVideo(container).dispatchEvent(new Event('ended')); await vi.runAllTimersAsync() })
    await act(async () => { activeVideo(container).dispatchEvent(new Event('ended')); await vi.runAllTimersAsync() })
    expect(activeVideo(container).src).toContain('b.mp4') // new entry now in rotation, no restart
  })

  it('the later of two rapid play messages wins', async () => {
    vi.useFakeTimers()
    const { container } = render(<App />)
    await act(async () => { await vi.runAllTimersAsync() })
    await act(async () => { mockWS.simulateOpen() })

    await act(async () => {
      mockWS.simulateMessage({ type: 'play', video_url: 'http://x/first.mp4' })
      mockWS.simulateMessage({ type: 'play', video_url: 'http://x/second.mp4' })
      await vi.runAllTimersAsync()
    })

    expect(activeVideo(container).src).toContain('second.mp4')
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
    await act(async () => { await vi.runAllTimersAsync() })

    await act(async () => { mockWS.simulateOpen() })
    await act(async () => {
      mockWS.simulateMessage({ type: 'play', video_url: 'http://localhost:8002/media/abc.mp4' })
      await vi.runAllTimersAsync()
    })

    const v = activeVideo(container)
    expect(v.src).toContain('/media/abc.mp4')
    expect(v.loop).toBe(false)
  })
})

describe('crossfade', () => {
  it('crossfades into the other element on a play message (roles swap)', async () => {
    vi.useFakeTimers()
    const { container } = render(<App />)
    await act(async () => { await vi.runAllTimersAsync() })
    const before = activeVideo(container)

    await act(async () => { mockWS.simulateOpen() })
    await act(async () => {
      mockWS.simulateMessage({ type: 'play', video_url: 'http://localhost:8002/media/abc.mp4' })
      await vi.runAllTimersAsync()
    })

    const after = activeVideo(container)
    expect(after).not.toBe(before)              // a different element is now visible
    expect(after.src).toContain('/media/abc.mp4')
    expect(after.style.opacity).toBe('1')
    expect(before.style.opacity).toBe('0')      // old element faded out
  })

  it('cross-fades audio: new element to full volume, old to zero', async () => {
    vi.useFakeTimers()
    const { container } = render(<App />)
    await act(async () => { await vi.runAllTimersAsync() })
    const before = activeVideo(container)

    await act(async () => { mockWS.simulateOpen() })
    await act(async () => {
      mockWS.simulateMessage({ type: 'play', video_url: 'http://x/named.mp4' })
      await vi.runAllTimersAsync()
    })

    const after = activeVideo(container)
    expect(after.volume).toBe(1)
    expect(before.volume).toBe(0)
  })

  it('completes the audio blend within 250ms (faster than the 500ms video fade) so an early name mention is not muted', async () => {
    vi.useFakeTimers()
    const { container } = render(<App />)
    await act(async () => { await vi.runAllTimersAsync() })
    const before = activeVideo(container)

    await act(async () => { mockWS.simulateOpen() })
    await act(async () => {
      mockWS.simulateMessage({ type: 'play', video_url: 'http://x/named.mp4' })
      await vi.advanceTimersByTimeAsync(250)
    })

    const after = activeVideo(container)
    expect(after.volume).toBe(1) // new clip already at full volume by 250ms
    expect(before.volume).toBe(0)
  })

  it('pauses the faded-out element after the transition', async () => {
    vi.useFakeTimers()
    const pauseSpy = HTMLMediaElement.prototype.pause as unknown as ReturnType<typeof vi.fn>
    const { container } = render(<App />)
    await act(async () => { await vi.runAllTimersAsync() })

    await act(async () => { mockWS.simulateOpen() })
    pauseSpy.mockClear()
    await act(async () => {
      mockWS.simulateMessage({ type: 'play', video_url: 'http://x/named.mp4' })
      await vi.runAllTimersAsync()
    })

    expect(pauseSpy).toHaveBeenCalled()
  })
})
