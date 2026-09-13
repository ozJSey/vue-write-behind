/**
 * The clock — the flush interval and the per-key backoff curve.
 *
 * Deliberately ignorant of writes and keys: it only knows "call this every N
 * ms" and "how long after the n-th failure". The decision to run at all belongs
 * to `useWriteBehind`, which starts it when work is queued and stops it when
 * there is none — an idle app must not hold a timer open.
 */
import type { WriteBehindRetryOptions } from './types'

const DEFAULT_INITIAL_DELAY = 1000
const DEFAULT_MAX_DELAY = 30000
const DEFAULT_FACTOR = 2

/**
 * Backoff for the n-th consecutive failure (1-based), in ms — or `undefined`
 * when retries are off, which parks the key until it is edited or retried.
 *
 * The cap matters: `factor ** attempts` reaches Infinity within a couple of
 * dozen failures, and a key parked at `Infinity` would never be retried, which
 * is exactly the silent write loss this library exists to prevent.
 */
export function createBackoff(
  retry: WriteBehindRetryOptions | false | undefined,
): (attempts: number) => number | undefined {
  if (retry === false) return () => undefined
  const {
    initialDelay = DEFAULT_INITIAL_DELAY,
    maxDelay = DEFAULT_MAX_DELAY,
    factor = DEFAULT_FACTOR,
  } = retry ?? {}
  return (attempts) => Math.min(initialDelay * factor ** (attempts - 1), maxDelay)
}

export interface SchedulerConfig {
  interval: number
  onTick: () => void
}

export interface Scheduler {
  /** Idempotent: calling it while running keeps the current phase. */
  start: () => void
  stop: () => void
  isRunning: () => boolean
}

export function createScheduler({ interval, onTick }: SchedulerConfig): Scheduler {
  let timer: ReturnType<typeof setInterval> | undefined

  return {
    start: () => {
      // Restarting would reset the phase, so a fast typist could push the flush
      // out indefinitely — the interval has to be a fixed window, not a debounce.
      if (timer !== undefined) return
      timer = setInterval(onTick, interval)
    },
    stop: () => {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    },
    isRunning: () => timer !== undefined,
  }
}
