import { StrictMode } from 'react'
import { render, act } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import App from '../App'

// Deterministic stand-in for the shuffle module: cycles the pool in REVERSED
// order (distinguishable from sequential list order). The real Fisher-Yates
// algorithm is covered by shuffle.test.ts; these tests verify App's wiring.
vi.mock('../shuffle', () => ({
  createShuffler: (initial: string[]) => {
    let pool = [...initial]
    let queue: string[] = []
    return {
      next: () => {
        if (queue.length === 0) queue = [...pool].reverse()
        return queue.shift() as string
      },
      setItems: (items: string[]) => { pool = [...items] },
    }
  },
}))

interface MockWSInstance {
  onopen: (() => void) | null
  onclose: (() => void) | null
  onmessage: ((e: { data: string }) => void) | null
  close: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
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
    send: vi.fn(),
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
  window.history.pushState({}, '', '/') // reset any screen_id query a test set
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

  it('starts idle playback exactly once on mount (no duplicate start that desyncs the crossfade)', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ videos: ['http://x/a.mp4', 'http://x/b.mp4'] }),
    }))
    const playSpy = HTMLMediaElement.prototype.play as unknown as ReturnType<typeof vi.fn>
    playSpy.mockClear()

    render(<App />)
    await act(async () => { await vi.runAllTimersAsync() })

    // Exactly one initial crossfade (one play). A second synchronous start would
    // flip frontIdx an extra time, desyncing it from the visible element and
    // freezing the rotation (handleEnded's front-element guard never matches).
    expect(playSpy).toHaveBeenCalledTimes(1)
  })

  it('idle rotation follows the shuffler order, not playlist order', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ videos: ['http://x/a.mp4', 'http://x/b.mp4', 'http://x/c.mp4'] }),
    }))
    const { container } = render(<App />)

    // The mocked shuffler cycles in reversed pool order: c → b → a. If the app
    // still walked the list sequentially this would start at a.mp4 and fail.
    await act(async () => { await vi.runAllTimersAsync() }) // fetch resolves + fade timer
    expect(activeVideo(container).src).toContain('c.mp4')

    await act(async () => { activeVideo(container).dispatchEvent(new Event('ended')); await vi.runAllTimersAsync() })
    expect(activeVideo(container).src).toContain('b.mp4')

    await act(async () => { activeVideo(container).dispatchEvent(new Event('ended')); await vi.runAllTimersAsync() })
    expect(activeVideo(container).src).toContain('a.mp4')
  })

  it('appends screen_id from the query string to the WS URL', async () => {
    vi.useFakeTimers()
    window.history.pushState({}, '', '/?screen_id=display-3')
    render(<App />)
    expect(MockWebSocket).toHaveBeenCalledWith('ws://localhost:8002/ws?screen_id=display-3')
  })

  it('connects without a screen_id param when none is in the query', async () => {
    vi.useFakeTimers()
    render(<App />)
    expect(MockWebSocket).toHaveBeenCalledWith('ws://localhost:8002/ws')
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

describe('temporal orchestration', () => {
  it('emits clip_ended over the WS when a personalized clip ends, and does not auto-advance idle', async () => {
    vi.useFakeTimers()
    window.history.pushState({}, '', '/?screen_id=display-1')
    const { container } = render(<App />)
    await act(async () => { await vi.runAllTimersAsync() })
    await act(async () => { mockWS.simulateOpen() })

    // A personalized clip arrives and plays.
    await act(async () => {
      mockWS.simulateMessage({ type: 'play', video_url: 'http://x/personal.mp4', clip_id: 'orch-u1-0' })
      await vi.runAllTimersAsync()
    })
    expect(activeVideo(container).src).toContain('personal.mp4')

    mockWS.send.mockClear()
    const srcBefore = activeVideo(container).src

    // The personalized clip ends.
    await act(async () => {
      activeVideo(container).dispatchEvent(new Event('ended'))
      await vi.runAllTimersAsync()
    })

    // Composer is told; the kiosk does NOT advance the idle rotation itself.
    expect(mockWS.send).toHaveBeenCalledTimes(1)
    const sent = JSON.parse(mockWS.send.mock.calls[0][0])
    expect(sent).toMatchObject({ type: 'clip_ended', screen_id: 'display-1', clip_id: 'orch-u1-0' })
    expect(activeVideo(container).src).toBe(srcBefore) // unchanged — composer decides next
  })

  it('resumes the idle shuffle on an idle message', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ videos: ['http://x/a.mp4', 'http://x/b.mp4'] }),
    }))
    const { container } = render(<App />)
    await act(async () => { await vi.runAllTimersAsync() })
    await act(async () => { mockWS.simulateOpen() })

    // A personalized clip takes over the display.
    await act(async () => {
      mockWS.simulateMessage({ type: 'play', video_url: 'http://x/personal.mp4', clip_id: 'c1' })
      await vi.runAllTimersAsync()
    })
    expect(activeVideo(container).src).toContain('personal.mp4')

    // Composer releases the display → idle resumes (an idle-pool video, not the clip).
    await act(async () => {
      mockWS.simulateMessage({ type: 'idle' })
      await vi.runAllTimersAsync()
    })
    expect(activeVideo(container).src).not.toContain('personal.mp4')
    expect(activeVideo(container).src).toMatch(/\/(a|b)\.mp4/)
  })

  it('an idle clip ending still auto-advances the rotation (no clip_ended emitted)', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ videos: ['http://x/a.mp4', 'http://x/b.mp4'] }),
    }))
    const { container } = render(<App />)
    await act(async () => { await vi.runAllTimersAsync() })
    await act(async () => { mockWS.simulateOpen() })
    mockWS.send.mockClear()

    const srcBefore = activeVideo(container).src
    await act(async () => {
      activeVideo(container).dispatchEvent(new Event('ended'))
      await vi.runAllTimersAsync()
    })

    // No personalized clip was playing → normal idle advance, nothing sent upstream.
    expect(mockWS.send).not.toHaveBeenCalled()
    expect(activeVideo(container).src).not.toBe(srcBefore)
  })
})

describe('playback echo (God View lifecycle)', () => {
  // The composer's _handle_display_echo relays these into the events journal
  // (playback/started|ended + ad_run/playing|completed). It requires the exact
  // message type plus a truthy trigger_id AND screen_id, and reads optional
  // duration_ms on ended. Timestamps are informational (composer uses its own clock).
  const sentOfType = (type: string): Array<Record<string, unknown>> =>
    mockWS.send.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .filter((m) => m.type === type)

  it('emits playback_started with trigger_id + screen_id when a personalized clip starts', async () => {
    vi.useFakeTimers()
    window.history.pushState({}, '', '/?screen_id=display-2')
    render(<App />)
    await act(async () => { await vi.runAllTimersAsync() })
    await act(async () => { mockWS.simulateOpen() })
    mockWS.send.mockClear()

    await act(async () => {
      mockWS.simulateMessage({ type: 'play', video_url: 'http://x/p.mp4', trigger_id: 'abc-123' })
      await vi.runAllTimersAsync()
    })

    const started = sentOfType('playback_started')
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({
      type: 'playback_started', trigger_id: 'abc-123', screen_id: 'display-2',
    })
    expect(typeof started[0].ts).toBe('string')
  })

  it('emits playback_ended with trigger_id + screen_id when the personalized clip finishes', async () => {
    vi.useFakeTimers()
    window.history.pushState({}, '', '/?screen_id=display-2')
    const { container } = render(<App />)
    await act(async () => { await vi.runAllTimersAsync() })
    await act(async () => { mockWS.simulateOpen() })

    await act(async () => {
      mockWS.simulateMessage({ type: 'play', video_url: 'http://x/p.mp4', trigger_id: 'abc-123' })
      await vi.runAllTimersAsync()
    })
    mockWS.send.mockClear()

    await act(async () => {
      activeVideo(container).dispatchEvent(new Event('ended'))
      await vi.runAllTimersAsync()
    })

    const ended = sentOfType('playback_ended')
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({
      type: 'playback_ended', trigger_id: 'abc-123', screen_id: 'display-2',
    })
    // The orchestrator-advancing clip_ended is still sent alongside the echo.
    expect(sentOfType('clip_ended')).toHaveLength(1)
  })

  it('includes duration_ms on playback_ended when the start time is known', async () => {
    vi.useFakeTimers()
    window.history.pushState({}, '', '/?screen_id=display-2')
    const { container } = render(<App />)
    await act(async () => { await vi.runAllTimersAsync() })
    await act(async () => { mockWS.simulateOpen() })

    await act(async () => {
      mockWS.simulateMessage({ type: 'play', video_url: 'http://x/p.mp4', trigger_id: 'abc-123' })
      await vi.runAllTimersAsync()
    })
    mockWS.send.mockClear()

    await act(async () => { vi.advanceTimersByTime(4000) })
    await act(async () => {
      activeVideo(container).dispatchEvent(new Event('ended'))
      await vi.runAllTimersAsync()
    })

    const ended = sentOfType('playback_ended')
    expect(ended).toHaveLength(1)
    expect(typeof ended[0].duration_ms).toBe('number')
    expect(ended[0].duration_ms as number).toBeGreaterThanOrEqual(4000)
  })

  it('emits playback_ended for the outgoing clip when superseded by an idle message', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ videos: ['http://x/a.mp4', 'http://x/b.mp4'] }),
    }))
    window.history.pushState({}, '', '/?screen_id=display-2')
    render(<App />)
    await act(async () => { await vi.runAllTimersAsync() })
    await act(async () => { mockWS.simulateOpen() })

    await act(async () => {
      mockWS.simulateMessage({ type: 'play', video_url: 'http://x/p.mp4', trigger_id: 'abc-123' })
      await vi.runAllTimersAsync()
    })
    mockWS.send.mockClear()

    await act(async () => {
      mockWS.simulateMessage({ type: 'idle' })
      await vi.runAllTimersAsync()
    })

    const ended = sentOfType('playback_ended')
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({ trigger_id: 'abc-123', screen_id: 'display-2' })
  })

  it('ends the outgoing clip and starts the new one when superseded by another play', async () => {
    vi.useFakeTimers()
    window.history.pushState({}, '', '/?screen_id=display-2')
    render(<App />)
    await act(async () => { await vi.runAllTimersAsync() })
    await act(async () => { mockWS.simulateOpen() })

    await act(async () => {
      mockWS.simulateMessage({ type: 'play', video_url: 'http://x/first.mp4', trigger_id: 't1' })
      await vi.runAllTimersAsync()
    })
    mockWS.send.mockClear()

    await act(async () => {
      mockWS.simulateMessage({ type: 'play', video_url: 'http://x/second.mp4', trigger_id: 't2' })
      await vi.runAllTimersAsync()
    })

    const ended = sentOfType('playback_ended')
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({ trigger_id: 't1', screen_id: 'display-2' })

    const started = sentOfType('playback_started')
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ trigger_id: 't2', screen_id: 'display-2' })
  })

  it('never emits an echo for a legacy play with no trigger_id (does not crash)', async () => {
    vi.useFakeTimers()
    window.history.pushState({}, '', '/?screen_id=display-2')
    const { container } = render(<App />)
    await act(async () => { await vi.runAllTimersAsync() })
    await act(async () => { mockWS.simulateOpen() })
    mockWS.send.mockClear()

    await act(async () => {
      mockWS.simulateMessage({ type: 'play', video_url: 'http://x/p.mp4', clip_id: 'orch-u1-0' })
      await vi.runAllTimersAsync()
    })
    await act(async () => {
      activeVideo(container).dispatchEvent(new Event('ended'))
      await vi.runAllTimersAsync()
    })

    expect(sentOfType('playback_started')).toHaveLength(0)
    expect(sentOfType('playback_ended')).toHaveLength(0)
    // clip_ended still flows so the orchestrator advances.
    expect(sentOfType('clip_ended')).toHaveLength(1)
  })
})

describe('click-to-pause', () => {
  it('clicking the screen pauses the visible video', async () => {
    vi.useFakeTimers()
    const pauseSpy = HTMLMediaElement.prototype.pause as unknown as ReturnType<typeof vi.fn>
    const { container } = render(<App />)
    await act(async () => { await vi.runAllTimersAsync() })
    pauseSpy.mockClear()

    await act(async () => { ;(container.firstChild as HTMLElement).click() })

    expect(pauseSpy).toHaveBeenCalled()
  })

  it('clicking again resumes the visible video', async () => {
    vi.useFakeTimers()
    const playSpy = HTMLMediaElement.prototype.play as unknown as ReturnType<typeof vi.fn>
    const { container } = render(<App />)
    await act(async () => { await vi.runAllTimersAsync() })

    // First click: pause
    await act(async () => { ;(container.firstChild as HTMLElement).click() })
    playSpy.mockClear()

    // Second click: resume
    await act(async () => { ;(container.firstChild as HTMLElement).click() })

    expect(playSpy).toHaveBeenCalled()
  })

  it('a play WS message still crossfades to the new clip while paused', async () => {
    vi.useFakeTimers()
    const { container } = render(<App />)
    await act(async () => { await vi.runAllTimersAsync() })

    // Pause first
    await act(async () => { ;(container.firstChild as HTMLElement).click() })

    // WS play message arrives while paused
    await act(async () => {
      mockWS.simulateMessage({ type: 'play', video_url: 'http://x/named.mp4' })
      await vi.runAllTimersAsync()
    })

    expect(activeVideo(container).src).toContain('named.mp4')
    expect(activeVideo(container).style.opacity).toBe('1')
  })

  it('ended while paused does not advance the idle rotation', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({ videos: ['http://x/a.mp4', 'http://x/b.mp4'] }),
    }))
    const { container } = render(<App />)
    await act(async () => { await vi.runAllTimersAsync() })
    expect(activeVideo(container).src).toContain('b.mp4') // mocked shuffler: reversed order

    // Pause
    await act(async () => { ;(container.firstChild as HTMLElement).click() })
    const srcBefore = activeVideo(container).src

    // Fire ended on the front video — should not advance rotation
    await act(async () => {
      activeVideo(container).dispatchEvent(new Event('ended'))
      await vi.runAllTimersAsync()
    })

    expect(activeVideo(container).src).toBe(srcBefore)
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

describe('debug badge (KIOSK_DEBUG)', () => {
  it('shows the badge with the screen id when ?debug=1', async () => {
    vi.useFakeTimers()
    window.history.pushState({}, '', '/?screen_id=display-2&debug=1')
    const { container } = render(<App />)
    await act(async () => { await vi.runAllTimersAsync() })
    const badge = container.querySelector('[data-testid="debug-badge"]')
    expect(badge?.textContent).toContain('display-2')
  })

  it('updates the badge with person and ad from a play message', async () => {
    vi.useFakeTimers()
    window.history.pushState({}, '', '/?screen_id=display-1&debug=1')
    const { container } = render(<App />)
    await act(async () => { await vi.runAllTimersAsync() })
    await act(async () => {
      mockWS.simulateMessage({
        type: 'play', video_url: 'http://x/v.mp4',
        person: 'Ragnar Ervin', ad: 'comp-fallingsnow',
      })
      await vi.runAllTimersAsync()
    })
    const badge = container.querySelector('[data-testid="debug-badge"]')
    expect(badge?.textContent).toContain('Ragnar Ervin')
    expect(badge?.textContent).toContain('comp-fallingsnow')
  })

  it('renders no badge without the debug param', async () => {
    vi.useFakeTimers()
    const { container } = render(<App />)
    await act(async () => { await vi.runAllTimersAsync() })
    expect(container.querySelector('[data-testid="debug-badge"]')).toBeNull()
  })
})
