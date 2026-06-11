// Pure window-layout helpers for the multi-display kiosk startup. Consumed by
// electron/main.js; unit-tested in src/__tests__/layout.test.ts.
const DEFAULT_COUNT = 4
const MAX_COUNT = 10

// DISPLAY_COUNT env → integer in [1, MAX_COUNT]; junk/unset → DEFAULT_COUNT.
function clampCount(raw) {
  const n = parseInt(raw, 10)
  if (Number.isNaN(n)) return DEFAULT_COUNT
  return Math.min(MAX_COUNT, Math.max(1, n))
}

// One window config per kiosk display. With enough physical monitors each
// window goes fullscreen on its own monitor; otherwise the windows tile a
// near-square grid on the primary display (dev/demo on a single screen).
function windowConfigs(count, displays) {
  if (displays.length >= count) {
    return displays.slice(0, count).map((d, i) => ({
      screenId: `display-${i + 1}`,
      x: d.bounds.x,
      y: d.bounds.y,
      width: d.bounds.width,
      height: d.bounds.height,
      fullscreen: true,
    }))
  }
  const { x, y, width, height } = displays[0].bounds
  const cols = Math.ceil(Math.sqrt(count))
  const rows = Math.ceil(count / cols)
  const w = Math.floor(width / cols)
  const h = Math.floor(height / rows)
  return Array.from({ length: count }, (_, i) => ({
    screenId: `display-${i + 1}`,
    x: x + (i % cols) * w,
    y: y + Math.floor(i / cols) * h,
    width: w,
    height: h,
    fullscreen: false,
  }))
}

module.exports = { clampCount, windowConfigs }
