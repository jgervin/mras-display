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
const MockWebSocket = vi.fn(() => {
  mockWS = {
    onopen: null, onclose: null, onmessage: null,
    close: vi.fn(),
    simulateOpen() { this.onopen?.() },
    simulateClose() { this.onclose?.() },
    simulateMessage(data) { this.onmessage?.({ data: JSON.stringify(data) }) },
  }
  return mockWS
})

beforeEach(() => {
  vi.stubGlobal('WebSocket', MockWebSocket)
  MockWebSocket.mockClear()
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
