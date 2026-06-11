import { describe, it, expect } from 'vitest'
import { clampCount, windowConfigs } from '../../electron/layout.js'

const display = (x: number, y: number, width: number, height: number) => ({
  bounds: { x, y, width, height },
})

describe('clampCount', () => {
  it('defaults to 4 when DISPLAY_COUNT is unset or junk', () => {
    expect(clampCount(undefined)).toBe(4)
    expect(clampCount('')).toBe(4)
    expect(clampCount('abc')).toBe(4)
  })

  it('clamps to the 1–10 range', () => {
    expect(clampCount('0')).toBe(1)
    expect(clampCount('15')).toBe(10)
    expect(clampCount('1')).toBe(1)
    expect(clampCount('10')).toBe(10)
  })

  it('passes through in-range values', () => {
    expect(clampCount('6')).toBe(6)
  })
})

describe('windowConfigs', () => {
  it('with enough monitors: one fullscreen window per monitor', () => {
    const displays = [display(0, 0, 1920, 1080), display(1920, 0, 1920, 1080)]
    const configs = windowConfigs(2, displays)
    expect(configs).toEqual([
      { screenId: 'display-1', x: 0, y: 0, width: 1920, height: 1080, fullscreen: true },
      { screenId: 'display-2', x: 1920, y: 0, width: 1920, height: 1080, fullscreen: true },
    ])
  })

  it('with one monitor and 4 windows: a 2x2 grid on the primary display', () => {
    const configs = windowConfigs(4, [display(0, 0, 1920, 1080)])
    expect(configs).toEqual([
      { screenId: 'display-1', x: 0, y: 0, width: 960, height: 540, fullscreen: false },
      { screenId: 'display-2', x: 960, y: 0, width: 960, height: 540, fullscreen: false },
      { screenId: 'display-3', x: 0, y: 540, width: 960, height: 540, fullscreen: false },
      { screenId: 'display-4', x: 960, y: 540, width: 960, height: 540, fullscreen: false },
    ])
  })

  it('with one monitor and 3 windows: 2-column grid, last row partial', () => {
    const configs = windowConfigs(3, [display(0, 0, 1920, 1080)])
    expect(configs.map((c: { x: number; y: number }) => [c.x, c.y])).toEqual([
      [0, 0],
      [960, 0],
      [0, 540],
    ])
  })

  it('grid windows respect a non-origin primary display', () => {
    const configs = windowConfigs(2, [display(100, 50, 1000, 800)])
    expect(configs[0]).toMatchObject({ x: 100, y: 50, width: 500, height: 800 })
    expect(configs[1]).toMatchObject({ x: 600, y: 50, width: 500, height: 800 })
  })
})
