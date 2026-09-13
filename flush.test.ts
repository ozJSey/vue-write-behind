/**
 * The two writer adapters, driven straight against a real outbox with a fake
 * network. No Vue and no timers — `now` is injected.
 */
import { describe, expect, it, vi } from 'vitest'
import { createOutbox } from './src/outbox'
import { createFlusher } from './src/flush'
import type { WriteBehindBatchWriter, WriteBehindWriter } from './src/types'
import type { Deferred } from './test-utils'
import { deferred, microtasks } from './test-utils'

/** Fake network with one controllable request per key. */
const gates = (...keys: string[]) => {
  const map = new Map<string, Deferred<void>>(keys.map((key) => [key, deferred()]))
  const gate = (key: string): Deferred<void> => {
    const found = map.get(key)
    if (!found) throw new Error(`test gate missing for "${key}"`)
    return found
  }
  return { gate, promiseFor: (key: string) => gate(key).promise }
}

const setup = <T>(
  writer: { write: WriteBehindWriter<T> } | { flush: WriteBehindBatchWriter<T> },
  now = () => 0,
) => {
  const outbox = createOutbox<T>({ retryDelay: () => 1000 })
  const flusher = createFlusher<T>({ outbox, writer, now })
  return { outbox, flusher }
}

describe('flush — per-key writer', () => {
  it('sends one request per due key with the value read at send time', async () => {
    const write = vi.fn<WriteBehindWriter<string>>(() => Promise.resolve())
    const { outbox, flusher } = setup<string>({ write })

    outbox.set('A1', 'first')
    outbox.set('A1', 'second')
    outbox.set('B2', 'b')
    flusher.dispatch()
    await microtasks()

    expect(write.mock.calls).toEqual([
      ['second', 'A1'],
      ['b', 'B2'],
    ])
    expect(outbox.isEmpty()).toBe(true)
  })

  it('does not call the writer when nothing is due', () => {
    const write = vi.fn<WriteBehindWriter<string>>()
    const { flusher } = setup<string>({ write })

    flusher.dispatch()

    expect(write).not.toHaveBeenCalled()
  })

  it('records a rejection against its own key and leaves it pending', async () => {
    const failure = new Error('503')
    const { outbox, flusher } = setup<string>({ write: () => Promise.reject(failure) })

    outbox.set('A1', 'a')
    flusher.dispatch()
    await microtasks()

    expect(outbox.pendingKeys()).toEqual(['A1'])
    expect(outbox.failures()[0]?.error).toBe(failure)
  })

  it('catches a writer that throws synchronously', async () => {
    const { outbox, flusher } = setup<string>({
      write: () => {
        throw new Error('bad url')
      },
    })

    outbox.set('A1', 'a')
    expect(() => flusher.dispatch()).not.toThrow()
    await microtasks()

    expect(outbox.failures()[0]?.attempts).toBe(1)
  })

  it('lets one key fail without touching its siblings (allSettled, not all)', async () => {
    const net = gates('A1', 'B2')
    const { outbox, flusher } = setup<string>({ write: (_value, key) => net.promiseFor(key) })

    outbox.set('A1', 'a')
    outbox.set('B2', 'b')
    flusher.dispatch()

    net.gate('A1').reject(new Error('503'))
    net.gate('B2').resolve()
    await microtasks()

    expect(outbox.pendingKeys()).toEqual(['A1'])
    expect(outbox.failures().map((f) => f.key)).toEqual(['A1'])
  })

  it('settles each key as its own request returns, not when the slowest does', async () => {
    const net = gates('A1', 'B2')
    const { outbox, flusher } = setup<string>({ write: (_value, key) => net.promiseFor(key) })

    outbox.set('A1', 'a')
    outbox.set('B2', 'b')
    flusher.dispatch()

    net.gate('B2').resolve()
    await microtasks()

    expect(outbox.pendingKeys()).toEqual(['A1'])
    expect(outbox.inFlightKeys()).toEqual(['A1'])
  })

  it('ignores whatever the writer resolves with — the response never comes back', async () => {
    const { outbox, flusher } = setup<string>({
      write: () => Promise.resolve({ value: 'server-says-this' }),
    })

    outbox.set('A1', 'local')
    flusher.dispatch()
    await microtasks()

    expect(outbox.isEmpty()).toBe(true)
  })
})

describe('flush — batch writer', () => {
  it('sends every due key as one call', async () => {
    const flushAll = vi.fn<WriteBehindBatchWriter<string>>(() => Promise.resolve())
    const { outbox, flusher } = setup<string>({ flush: flushAll })

    outbox.set('A1', 'a')
    outbox.set('B2', 'b')
    flusher.dispatch()
    await microtasks()

    expect(flushAll).toHaveBeenCalledTimes(1)
    expect(flushAll.mock.calls[0]?.[0]).toEqual([
      ['A1', 'a'],
      ['B2', 'b'],
    ])
    expect(outbox.isEmpty()).toBe(true)
  })

  it('keeps the whole batch pending when the call throws', async () => {
    const { outbox, flusher } = setup<string>({ flush: () => Promise.reject(new Error('500')) })

    outbox.set('A1', 'a')
    outbox.set('B2', 'b')
    flusher.dispatch()
    await microtasks()

    expect(outbox.pendingKeys()).toEqual(['A1', 'B2'])
    expect(outbox.failures().map((f) => f.attempts)).toEqual([1, 1])
  })

  it('fails only the keys the call reports', async () => {
    const { outbox, flusher } = setup<string>({ flush: () => Promise.resolve({ failed: ['B2'] }) })

    outbox.set('A1', 'a')
    outbox.set('B2', 'b')
    flusher.dispatch()
    await microtasks()

    expect(outbox.pendingKeys()).toEqual(['B2'])
    expect(outbox.failures()[0]?.key).toBe('B2')
  })

  it('applies the version guard per key inside a batch', async () => {
    const gate = deferred()
    const { outbox, flusher } = setup<string>({ flush: () => gate.promise })

    outbox.set('A1', 'a')
    outbox.set('B2', 'b')
    flusher.dispatch()
    outbox.set('A1', 'typed-during-the-batch')
    gate.resolve()
    await microtasks()

    expect(outbox.pendingKeys()).toEqual(['A1'])
    expect(outbox.take(0)[0]?.value).toBe('typed-during-the-batch')
  })

  it('treats a void result as "all written"', async () => {
    const { outbox, flusher } = setup<string>({ flush: () => undefined })

    outbox.set('A1', 'a')
    flusher.dispatch()
    await microtasks()

    expect(outbox.isEmpty()).toBe(true)
  })
})

describe('flush — dispatch clocks', () => {
  it('respects a key that is not due yet', () => {
    const write = vi.fn<WriteBehindWriter<string>>()
    const { outbox, flusher } = setup<string>({ write }, () => 500)

    outbox.set('A1', 'a', 900)
    flusher.dispatch()

    expect(write).not.toHaveBeenCalled()
  })

  it('flush() ignores the clock and resolves once the requests it started settle', async () => {
    const gate = deferred()
    const write = vi.fn<WriteBehindWriter<string>>(() => gate.promise)
    const { outbox, flusher } = setup<string>({ write }, () => 500)

    outbox.set('A1', 'a', 90000)
    let settled = false
    const done = flusher.flush().then(() => {
      settled = true
    })

    expect(write).toHaveBeenCalledTimes(1)
    await microtasks()
    expect(settled).toBe(false)

    gate.resolve()
    await done

    expect(settled).toBe(true)
    expect(outbox.isEmpty()).toBe(true)
  })

  it('flush() waits for a flight that was already in the air', async () => {
    const gate = deferred()
    const { outbox, flusher } = setup<string>({ write: () => gate.promise })

    outbox.set('A1', 'a')
    flusher.dispatch()

    let settled = false
    const done = flusher.flush().then(() => {
      settled = true
    })
    await microtasks()
    expect(settled).toBe(false)

    gate.resolve()
    await done
    expect(settled).toBe(true)
  })

  it('flush() with nothing queued resolves immediately', async () => {
    const write = vi.fn<WriteBehindWriter<string>>()
    const { flusher } = setup<string>({ write })

    await expect(flusher.flush()).resolves.toBeUndefined()
    expect(write).not.toHaveBeenCalled()
  })
})
