// Type declarations for the CJS layout helpers (electron/layout.js), used by
// the vitest suite in src/__tests__/layout.test.ts.
export interface WindowConfig {
  screenId: string
  x: number
  y: number
  width: number
  height: number
  fullscreen: boolean
}

export interface DisplayLike {
  bounds: { x: number; y: number; width: number; height: number }
}

export function clampCount(raw: string | undefined): number
export function windowConfigs(count: number, displays: DisplayLike[]): WindowConfig[]
