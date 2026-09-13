/**
 * The correctness core. No Vue, no timers, no I/O — every clock reading is a
 * number passed in, so these tests are fully deterministic.
 *
 * H1 (version guard), H3 (bounded + latest error only), H5 (reentrancy) all
 * live here; the Vue-level suite only re-proves them end-to-end.
 */
import { describe, expect, it, vi } from 'vitest'
import { createOutbox } from './src/outbox'

const outbox = <T>(retryDelay: (attempts: number) => number | undefined = () => 1000) =>
  createOutbox<T>({ retryDelay })

describe('outbox — queueing', () => {
  it('coalesces N edits into one entry carrying the newest value', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    box.set('A1', 'b')
    box.set('A1', 'c')

    expect(box.pendingKeys()).toEqual(['A1'])
    const batch = box.take(0)
    expect(batch).toHaveLength(1)
    expect(batch[0]?.value).toBe('c')
  })

  it('keeps keys independent and in insertion order', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    box.set('B2', 'b')

    expect(box.take(0).map((e) => e.key)).toEqual(['A1', 'B2'])
  })

  it('is bounded by the number of keys, not the number of edits (H3)', () => {
    const box = outbox<number>()
    for (let i = 0; i < 500; i += 1) box.set('A1', i)

    expect(box.pendingKeys()).toHaveLength(1)
    expect(box.take(0)[0]?.value).toBe(499)
  })

  it('starts empty and reports no scheduled work', () => {
    const box = outbox<string>()
    expect(box.isEmpty()).toBe(true)
    expect(box.hasScheduledWork()).toBe(false)
    expect(box.take(0)).toEqual([])
  })
})

describe('outbox — reentrancy (H5)', () => {
  it('never hands out a key that is already in flight', () => {
    const box = outbox<string>()
    box.set('A1', 'a')

    expect(box.take(0)).toHaveLength(1)
    expect(box.take(0)).toEqual([])
  })

  it('still skips an in-flight key that has been edited since (H5 beats dirtiness)', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    const [sent] = box.take(0)
    box.set('A1', 'b')

    expect(box.pendingKeys()).toEqual(['A1'])
    expect(box.inFlightKeys()).toEqual(['A1'])
    expect(box.take(0)).toEqual([])
    expect(sent?.value).toBe('a')
  })

  it('reports nothing schedulable while every entry is in flight', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    box.take(0)

    expect(box.isEmpty()).toBe(false)
    expect(box.hasScheduledWork()).toBe(false)
  })
})

describe('outbox — the version guard (H1)', () => {
  it('clears a key whose version did not move while its write was in flight', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    const [sent] = box.take(0)

    box.settle('A1', sent!.sentVersion)

    expect(box.pendingKeys()).toEqual([])
    expect(box.isEmpty()).toBe(true)
  })

  it('does NOT clear a key edited while its own write was in flight', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    const [sent] = box.take(0)
    box.set('A1', 'b') // the edit a boolean dirty flag would lose

    box.settle('A1', sent!.sentVersion)

    expect(box.pendingKeys()).toEqual(['A1'])
    expect(box.inFlightKeys()).toEqual([])
    expect(box.take(0)[0]?.value).toBe('b')
  })

  it('ignores a response from a flight that is no longer current', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    const [first] = box.take(0)
    box.discard('A1')
    box.set('A1', 'b')
    const [second] = box.take(0)

    // the discarded flight resolves late — it must not touch the new entry
    box.settle('A1', first!.sentVersion)
    expect(box.pendingKeys()).toEqual(['A1'])
    expect(box.inFlightKeys()).toEqual(['A1'])

    box.settle('A1', second!.sentVersion)
    expect(box.isEmpty()).toBe(true)
  })

  it('gives every send a distinct version, even across discard', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    const [first] = box.take(0)
    box.discard('A1')
    box.set('A1', 'b')
    const [second] = box.take(0)

    expect(second!.sentVersion).not.toBe(first!.sentVersion)
  })

  it('settling an unknown key is a no-op', () => {
    const box = outbox<string>()
    expect(() => box.settle('nope', 1)).not.toThrow()
    expect(box.isEmpty()).toBe(true)
  })
})

describe('outbox — failure never clears (H1)', () => {
  it('keeps the key pending and records the error', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    const [sent] = box.take(0)

    box.fail('A1', sent!.sentVersion, new Error('boom'), 0)

    expect(box.pendingKeys()).toEqual(['A1'])
    expect(box.inFlightKeys()).toEqual([])
    expect(box.failures()).toEqual([
      { key: 'A1', error: expect.any(Error), attempts: 1, retryAt: 1000 },
    ])
  })

  it('re-sends the CURRENT value after a failure, not the one that failed', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    const [sent] = box.take(0)
    box.fail('A1', sent!.sentVersion, new Error('boom'), 0)
    box.set('A1', 'typed-since')

    expect(box.take(5000)[0]?.value).toBe('typed-since')
  })

  it('holds the key back until its backoff is due', () => {
    const box = outbox<string>((attempts) => attempts * 1000)
    box.set('A1', 'a')
    const [sent] = box.take(0)
    box.fail('A1', sent!.sentVersion, new Error('boom'), 500)

    expect(box.take(1000)).toEqual([]) // retryAt is 1500
    expect(box.take(1499)).toEqual([])
    expect(box.take(1500)).toHaveLength(1)
  })

  it('counts consecutive failures and keeps only the latest error (H3)', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    box.fail('A1', box.take(0)[0]!.sentVersion, new Error('one'), 0)
    box.fail('A1', box.take(2000)[0]!.sentVersion, new Error('two'), 2000)

    const failures = box.failures()
    expect(failures).toHaveLength(1)
    expect(failures[0]?.attempts).toBe(2)
    const latest = failures[0]?.error
    // `error` is `unknown` by design — narrow it rather than cast it.
    expect(latest).toBeInstanceOf(Error)
    expect(latest instanceof Error ? latest.message : undefined).toBe('two')
  })

  it('does not let a fresh edit shorten an active backoff', () => {
    const box = outbox<string>(() => 8000)
    box.set('A1', 'a')
    box.fail('A1', box.take(0)[0]!.sentVersion, new Error('boom'), 0)
    box.set('A1', 'still-typing', 100)

    expect(box.take(100)).toEqual([])
    expect(box.take(8000)).toHaveLength(1)
  })

  it('clears the failure and the backoff once a write succeeds', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    box.fail('A1', box.take(0)[0]!.sentVersion, new Error('boom'), 0)
    box.set('A1', 'b')
    const [retry] = box.take(1000)
    box.settle('A1', retry!.sentVersion)

    expect(box.failures()).toEqual([])
    expect(box.isEmpty()).toBe(true)
  })

  it('resets the attempt count when a success lands on a key that moved on', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    box.fail('A1', box.take(0)[0]!.sentVersion, new Error('boom'), 0)
    const [retry] = box.take(1000)
    box.set('A1', 'newer')
    box.settle('A1', retry!.sentVersion)

    expect(box.failures()).toEqual([])
    expect(box.take(1000)).toHaveLength(1) // due immediately, no leftover backoff
  })

  it('ignores a failure from a flight that is no longer current', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    const [first] = box.take(0)
    box.discard('A1')
    box.set('A1', 'b')

    box.fail('A1', first!.sentVersion, new Error('late'), 0)

    expect(box.failures()).toEqual([])
    expect(box.take(0)).toHaveLength(1)
  })
})

describe('outbox — retry disabled', () => {
  it('blocks the key instead of dropping it', () => {
    const box = outbox<string>(() => undefined)
    box.set('A1', 'a')
    box.fail('A1', box.take(0)[0]!.sentVersion, new Error('boom'), 0)

    expect(box.pendingKeys()).toEqual(['A1'])
    expect(box.take(Number.POSITIVE_INFINITY)).toEqual([])
    expect(box.hasScheduledWork()).toBe(false)
    expect(box.failures()[0]?.retryAt).toBeUndefined()
  })

  it('re-arms on a fresh edit — a new value is a new write, not a retry', () => {
    const box = outbox<string>(() => undefined)
    box.set('A1', 'a')
    box.fail('A1', box.take(0)[0]!.sentVersion, new Error('boom'), 0)
    box.set('A1', 'b')

    expect(box.take(0)[0]?.value).toBe('b')
  })

  it('re-arms on clearBackoff', () => {
    const box = outbox<string>(() => undefined)
    box.set('A1', 'a')
    box.fail('A1', box.take(0)[0]!.sentVersion, new Error('boom'), 0)
    box.clearBackoff('A1')

    expect(box.failures()).toEqual([])
    expect(box.take(0)).toHaveLength(1)
  })
})

describe('outbox — clearBackoff', () => {
  it('makes a backed-off key due immediately and resets its attempt count', () => {
    const box = outbox<string>(() => 30000)
    box.set('A1', 'a')
    box.fail('A1', box.take(0)[0]!.sentVersion, new Error('boom'), 0)

    box.clearBackoff('A1')

    expect(box.take(0)).toHaveLength(1)
    expect(box.failures()).toEqual([])
  })

  it('clears every key when called without one', () => {
    const box = outbox<string>(() => 30000)
    box.set('A1', 'a')
    box.set('B2', 'b')
    for (const sent of box.take(0)) box.fail(sent.key, sent.sentVersion, new Error('boom'), 0)

    box.clearBackoff()

    expect(box.take(0)).toHaveLength(2)
  })

  it('leaves an in-flight key alone', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    box.take(0)

    box.clearBackoff('A1')

    expect(box.take(0)).toEqual([])
    expect(box.inFlightKeys()).toEqual(['A1'])
  })
})

describe('outbox — discard is the only way to lose a write', () => {
  it('drops the entry', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    box.discard('A1')

    expect(box.isEmpty()).toBe(true)
    expect(box.take(0)).toEqual([])
  })

  it('drops an in-flight entry and ignores its late response', () => {
    const box = outbox<string>()
    box.set('A1', 'a')
    const [sent] = box.take(0)
    box.discard('A1')

    box.settle('A1', sent!.sentVersion)
    box.fail('A1', sent!.sentVersion, new Error('late'), 0)

    expect(box.isEmpty()).toBe(true)
  })
})

describe('outbox — change notification', () => {
  it('fires on every state transition so the Vue layer can mirror it', () => {
    const onChange = vi.fn()
    const box = createOutbox<string>({ retryDelay: () => 1000, onChange })

    box.set('A1', 'a')
    expect(onChange).toHaveBeenCalledTimes(1)

    const [sent] = box.take(0)
    expect(onChange).toHaveBeenCalledTimes(2)

    box.settle('A1', sent!.sentVersion)
    expect(onChange).toHaveBeenCalledTimes(3)
  })

  it('does not fire for a take that finds nothing', () => {
    const onChange = vi.fn()
    const box = createOutbox<string>({ retryDelay: () => 1000, onChange })

    box.take(0)

    expect(onChange).not.toHaveBeenCalled()
  })
})
