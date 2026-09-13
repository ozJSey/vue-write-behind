/**
 * The clock: the flush interval and the per-key backoff curve. Fake timers
 * only — nothing here knows what a write is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBackoff, createScheduler } from './src/scheduler'

describe('createBackoff', () => {
  it('runs 1 → 2 → 4 → 8 → 16 → 30s and stays capped', () => {
    const backoff = createBackoff(undefined)

    expect([1, 2, 3, 4, 5, 6, 7, 20].map(backoff)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ])
  })

  it('honours a custom curve', () => {
    const backoff = createBackoff({ initialDelay: 100, factor: 3, maxDelay: 1000 })

    expect([1, 2, 3, 4].map(backoff)).toEqual([100, 300, 900, 1000])
  })

  it('returns undefined for every attempt when retry is off', () => {
    const backoff = createBackoff(false)

    expect([1, 2, 99].map(backoff)).toEqual([undefined, undefined, undefined])
  })

  it('never returns a delay above the cap, whatever the attempt count', () => {
    const backoff = createBackoff({ initialDelay: 1000, factor: 10 })

    expect(backoff(50)).toBe(30000)
    expect(Number.isFinite(backoff(1000) ?? Number.POSITIVE_INFINITY)).toBe(true)
  })
})

describe('createScheduler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does not tick until it is started', () => {
    const onTick = vi.fn()
    createScheduler({ interval: 1000, onTick })

    vi.advanceTimersByTime(5000)

    expect(onTick).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ticks on the interval once started', () => {
    const onTick = vi.fn()
    const scheduler = createScheduler({ interval: 1000, onTick })

    scheduler.start()
    vi.advanceTimersByTime(999)
    expect(onTick).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onTick).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(2000)
    expect(onTick).toHaveBeenCalledTimes(3)
  })

  it('start() is idempotent — it never resets the phase or doubles the rate', () => {
    const onTick = vi.fn()
    const scheduler = createScheduler({ interval: 1000, onTick })

    scheduler.start()
    vi.advanceTimersByTime(900)
    scheduler.start()
    scheduler.start()
    vi.advanceTimersByTime(100)

    expect(onTick).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('stop() clears the timer so nothing is left running', () => {
    const onTick = vi.fn()
    const scheduler = createScheduler({ interval: 1000, onTick })

    scheduler.start()
    scheduler.stop()

    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(10000)
    expect(onTick).not.toHaveBeenCalled()
  })

  it('stop() is safe when it was never started', () => {
    const scheduler = createScheduler({ interval: 1000, onTick: vi.fn() })

    expect(() => scheduler.stop()).not.toThrow()
  })

  it('reports whether it is running', () => {
    const scheduler = createScheduler({ interval: 1000, onTick: vi.fn() })

    expect(scheduler.isRunning()).toBe(false)
    scheduler.start()
    expect(scheduler.isRunning()).toBe(true)
    scheduler.stop()
    expect(scheduler.isRunning()).toBe(false)
  })
})
