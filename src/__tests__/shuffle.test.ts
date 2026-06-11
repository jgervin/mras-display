import { describe, it, expect } from 'vitest'
import { createShuffler } from '../shuffle'

describe('createShuffler — shuffled cycle', () => {
  it('plays every item exactly once per cycle', () => {
    const s = createShuffler(['a', 'b', 'c'])
    const cycle1 = [s.next(), s.next(), s.next()]
    expect([...cycle1].sort()).toEqual(['a', 'b', 'c'])
    const cycle2 = [s.next(), s.next(), s.next()]
    expect([...cycle2].sort()).toEqual(['a', 'b', 'c'])
  })

  it('a new cycle never starts with the previous cycle\'s last item', () => {
    // rng queue: one Fisher-Yates call per cycle for a 2-item pool.
    // Cycle 1 with rng 0.99 → [a, b] (ends on b). Cycle 2 with rng 0 → [b, a],
    // which would start on b — the no-immediate-repeat guard must reorder it.
    const rngValues = [0.99, 0, 0.99]
    const rng = () => rngValues.shift() ?? 0.5
    const s = createShuffler(['a', 'b'], rng)

    expect([s.next(), s.next()]).toEqual(['a', 'b'])
    const third = s.next()
    expect(third).not.toBe('b') // guard: no immediate repeat across the boundary
    const fourth = s.next()
    expect([third, fourth].sort()).toEqual(['a', 'b']) // cycle still covers the pool
  })

  it('a single-item pool repeats that item without hanging', () => {
    const s = createShuffler(['only'])
    expect([s.next(), s.next(), s.next()]).toEqual(['only', 'only', 'only'])
  })

  it('setItems: newly added items join the next cycle', () => {
    const s = createShuffler(['a'])
    expect(s.next()).toBe('a')
    s.setItems(['a', 'b'])
    const nextCycle = [s.next(), s.next()]
    expect([...nextCycle].sort()).toEqual(['a', 'b'])
  })

  it('setItems mid-cycle does not disturb the current cycle', () => {
    // Identity-order rng (j === i on every Fisher-Yates step).
    const s = createShuffler(['a', 'b', 'c'], () => 0.999999)
    const first = s.next()
    s.setItems(['a', 'b', 'c', 'd'])
    const rest = [s.next(), s.next()]
    // current cycle finishes the original three before 'd' can appear
    expect([first, ...rest].sort()).toEqual(['a', 'b', 'c'])
    const cycle2 = [s.next(), s.next(), s.next(), s.next()]
    expect([...cycle2].sort()).toEqual(['a', 'b', 'c', 'd'])
  })
})
