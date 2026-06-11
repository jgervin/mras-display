// Shuffled-cycle iterator over the idle-ad pool: every item plays once per
// cycle (Fisher-Yates), and a new cycle never opens with the item that just
// played. setItems swaps the pool used for subsequent cycles (drop-in
// playlist refreshes) without disturbing the cycle in progress.
export interface Shuffler<T> {
  next(): T
  setItems(items: T[]): void
}

export function createShuffler<T>(initial: T[], rng: () => number = Math.random): Shuffler<T> {
  let pool = [...initial]
  let queue: T[] = []
  let last: T | undefined

  const shuffle = (items: T[]): T[] => {
    const a = [...items]
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      ;[a[i], a[j]] = [a[j], a[i]]
    }
    return a
  }

  return {
    next() {
      if (queue.length === 0) {
        queue = shuffle(pool)
        // No immediate repeat across the cycle boundary: if the fresh cycle
        // would open with the item that just played, send it to the back.
        if (queue.length > 1 && queue[0] === last) {
          queue.push(queue.shift() as T)
        }
      }
      last = queue.shift() as T
      return last
    },
    setItems(items: T[]) {
      pool = [...items]
    },
  }
}
