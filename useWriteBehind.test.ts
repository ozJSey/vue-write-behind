/**
 * The Vue surface, end to end: a real reactive record, a real clock (faked) and
 * a fake network of deferred promises the test settles by hand.
 *
 * Every acceptance case from the ticket lives here; the invariants themselves
 * are pinned far more cheaply in `outbox.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, reactive, ref, watch, watchEffect, type EffectScope } from 'vue'
import { useWriteBehind } from './src/useWriteBehind'
import type { WriteBehind, WriteBehindAttempt } from './src/types'
import type { Deferred } from './test-utils'
import { deferred, microtasks } from './test-utils'

const scopes: EffectScope[] = []

/** Run a composable in its own scope, the way `setup()` would. */
function inScope<R extends object>(factory: () => R): { scope: EffectScope; value: R } {
  const scope = effectScope()
  scopes.push(scope)
  const value = scope.run(factory)
  if (!value) throw new Error('effect scope did not run')
  return { scope, value }
}

/** A writer whose every call the test settles individually. */
function fakeNetwork() {
  const calls: {
    value: unknown
    key: string
    at: number
    attempt: WriteBehindAttempt
  }[] = []
  const gates: Deferred<void>[] = []
  const write = (value: unknown, key: string, attempt: WriteBehindAttempt): Promise<void> => {
    calls.push({ value, key, at: Date.now(), attempt })
    const gate = deferred()
    gates.push(gate)
    return gate.promise
  }
  return {
    write,
    calls,
    gates,
    values: () => calls.map((call) => call.value),
    keys: () => calls.map((call) => call.key),
    times: () => calls.map((call) => call.at),
    reasons: () => calls.map((call) => call.attempt.reason),
    finals: () => calls.map((call) => call.attempt.final),
  }
}

/** Let the source watcher run, then run the flush timer for `ms`. */
async function tick(ms = 1000): Promise<void> {
  await nextTick()
  await vi.advanceTimersByTimeAsync(ms)
  await microtasks()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})

afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop()
  vi.useRealTimers()
})

describe('the bare form — no options', () => {
  it('collapses N edits into one request carrying the newest value', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const net = fakeNetwork()
    inScope(() => useWriteBehind(cells, net.write))

    for (const value of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) cells.A1 = value
    await tick()

    expect(net.calls).toHaveLength(1)
    expect(net.values()).toEqual(['j'])
  })

  it('does not queue the values the record started with', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'from-the-server', B2: 'also' })
    const net = fakeNetwork()
    const { value: outbox } = inScope(() => useWriteBehind(cells, net.write))

    expect(outbox.pending).toEqual([])
    await tick(5000)

    expect(net.calls).toEqual([])
  })

  it('waits a full interval rather than firing on the first keystroke', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const net = fakeNetwork()
    inScope(() => useWriteBehind(cells, net.write))

    cells.A1 = 'a'
    await nextTick()
    await vi.advanceTimersByTimeAsync(999)
    expect(net.calls).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    expect(net.calls).toHaveLength(1)
  })

  it('never overwrites local state with the response', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const { value: outbox } = inScope(() =>
      useWriteBehind(cells, () => Promise.resolve({ A1: 'WHAT-THE-SERVER-THINKS' })),
    )

    cells.A1 = 'what the user typed'
    await tick()

    expect(cells.A1).toBe('what the user typed')
    expect(outbox.pending).toEqual([])
  })

  it('accepts a ref of a record as well as a reactive one', async () => {
    const cells = ref<Record<string, string>>({ A1: 'foo' })
    const net = fakeNetwork()
    inScope(() => useWriteBehind(cells, net.write))

    cells.value.A1 = 'edited'
    await tick()

    expect(net.calls).toHaveLength(1)
    expect(net.values()).toEqual(['edited'])
  })
})

describe('a key edited while its own write is in flight (H1)', () => {
  it('sends exactly two requests, the second carrying the newest value', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const net = fakeNetwork()
    const { value: outbox } = inScope(() => useWriteBehind(cells, net.write))

    cells.A1 = 'first'
    await tick()
    expect(net.values()).toEqual(['first'])

    // typed while the request is still out
    cells.A1 = 'second'
    await nextTick()
    net.gates[0]?.resolve()
    await microtasks()

    // the response must NOT have cleared the key
    expect(outbox.pending).toEqual(['A1'])
    expect(outbox.inFlight).toEqual([])

    await tick()
    expect(net.values()).toEqual(['first', 'second'])

    net.gates[1]?.resolve()
    await microtasks()
    expect(outbox.pending).toEqual([])
  })

  it('never has two requests in flight for one key (H5)', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const net = fakeNetwork()
    const { value: outbox } = inScope(() => useWriteBehind(cells, net.write))

    cells.A1 = 'first'
    await tick()

    for (const value of ['second', 'third', 'fourth']) {
      cells.A1 = value
      await tick()
    }

    expect(net.calls).toHaveLength(1)
    expect(outbox.inFlight).toEqual(['A1'])

    // The interval alone cannot prove the guard: with the only key in flight
    // there is nothing due, so the scheduler is stopped and `take()` is never
    // reached. Force a dispatch — flush() ignores every clock, so if anything
    // but the flight itself were holding the key back, a second request would
    // go out here. (Not awaited: the gate is still open.)
    void outbox.flush()
    // …and the tab-hidden path, which is the other forced dispatch.
    void outbox.flush()
    await microtasks()
    expect(net.calls).toHaveLength(1)

    net.gates[0]?.resolve()
    await tick()
    expect(net.values()).toEqual(['first', 'fourth'])
  })
})

describe('discard() while a request is in flight', () => {
  /**
   * The data-loss bug fixed in 0.1.1, driven end to end.
   *
   * `discard()` used to delete the outbox entry that was the library's ONLY
   * record of the request in the air. The next edit therefore opened a SECOND
   * concurrent request for the same key — and when the first one is slow and the
   * second is fast, the responses land out of order and the server is left
   * holding the OLD value while the screen shows the new one. Nothing in the
   * client says so: no error, no failed entry, `pending` reports `[]`.
   *
   * So the assertion is about what the SERVER ends up holding, not about what
   * the library thinks it did.
   */
  it('never opens a second concurrent request, so the server keeps the newest value', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'v0' })

    // A server that applies writes in the order the requests LAND.
    const applied: string[] = []
    let serverValue = 'v0'
    let inAir = 0
    let maxInAir = 0
    let latency = 3000 // the first request is slow…
    const write = (value: string): Promise<void> => {
      inAir += 1
      maxInAir = Math.max(maxInAir, inAir)
      const takes = latency
      latency = 50 // …every one after it is fast
      return new Promise((resolve) => {
        setTimeout(() => {
          applied.push(value)
          serverValue = value
          inAir -= 1
          resolve()
        }, takes)
      })
    }

    const { value: outbox } = inScope(() => useWriteBehind(cells, write))

    cells.A1 = 'v1-slow'
    await tick() // t=1000: the slow request is on the wire, landing at t=4000
    expect(outbox.inFlight).toEqual(['A1'])

    outbox.discard('A1') // the user drops the pending write while it is in the air
    cells.A1 = 'v2-fast' // …and immediately types again

    await tick(20000)

    // What the SERVER holds is the assertion that matters.
    expect(serverValue).toBe('v2-fast') // 0.1.0 left 'v1-slow' here
    expect(applied).toEqual(['v1-slow', 'v2-fast'])
    expect(maxInAir).toBe(1)
    expect(cells.A1).toBe('v2-fast')
    expect(outbox.pending).toEqual([])
  })

  it('holds the key back until the discarded flight lands, then sends the new value once', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'v0' })
    const net = fakeNetwork()
    const { value: outbox } = inScope(() => useWriteBehind(cells, net.write))

    cells.A1 = 'v1'
    await tick()
    outbox.discard('A1')
    cells.A1 = 'v2'
    await tick(10000)

    // The request for v1 has not answered yet, so nothing new may go out.
    expect(net.values()).toEqual(['v1'])
    expect(outbox.pending).toEqual(['A1'])
    // The wire is busy with a request nobody owns, so the queued write is
    // pending but explicitly NOT reported as being saved.
    expect(outbox.inFlight).toEqual([])
    expect(outbox.isSyncing).toBe(false)

    net.gates[0]?.resolve() // the discarded flight finally lands
    await tick()

    expect(net.values()).toEqual(['v1', 'v2'])
  })

  it('does not record a discarded flight\'s failure against the key that replaced it', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'v0' })
    const net = fakeNetwork()
    const { value: outbox } = inScope(() => useWriteBehind(cells, net.write))

    cells.A1 = 'v1'
    await tick()
    outbox.discard('A1')
    cells.A1 = 'v2'
    net.gates[0]?.reject(new Error('503 for a write nobody is waiting for'))
    await microtasks()

    expect(outbox.failed).toEqual([])
    await tick()
    expect(net.values()).toEqual(['v1', 'v2'])
  })
})

describe('failure never rolls back and never drops a write', () => {
  it('keeps the key pending and records the error', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const failure = new Error('503')
    const { value: outbox } = inScope(() => useWriteBehind(cells, () => Promise.reject(failure)))

    cells.A1 = 'edited'
    await tick()

    expect(cells.A1).toBe('edited')
    expect(outbox.pending).toEqual(['A1'])
    expect(outbox.failed).toEqual([
      { key: 'A1', error: failure, attempts: 1, retryAt: 2000 },
    ])
  })

  it('re-sends what has been typed since, not the value that failed', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const net = fakeNetwork()
    inScope(() => useWriteBehind(cells, net.write))

    cells.A1 = 'sent-and-failed'
    await tick()
    net.gates[0]?.reject(new Error('503'))
    await microtasks()

    cells.A1 = 'typed-since'
    await tick(1000)

    expect(net.values()).toEqual(['sent-and-failed', 'typed-since'])
  })

  it('backs off 1 → 2 → 4 → 8 → 16 → 30 → 30s', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const net = fakeNetwork()
    const failEverything = (
      value: unknown,
      key: string,
      attempt: WriteBehindAttempt,
    ): Promise<void> => {
      const promise = net.write(value, key, attempt)
      net.gates[net.gates.length - 1]?.reject(new Error('503'))
      return promise
    }
    inScope(() => useWriteBehind(cells, failEverything))

    cells.A1 = 'edited'
    await tick(100000)

    const gaps = net.times().map((at, index) => at - (net.times()[index - 1] ?? 0))
    expect(gaps).toEqual([1000, 1000, 2000, 4000, 8000, 16000, 30000, 30000])
  })

  it('lets one failing key retry without blocking a healthy sibling', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'a', B2: 'b' })
    const net = fakeNetwork()
    const { value: outbox } = inScope(() => useWriteBehind(cells, net.write))

    cells.A1 = 'a-edited'
    cells.B2 = 'b-edited'
    await tick()

    expect(net.keys()).toEqual(['A1', 'B2'])
    net.gates[0]?.reject(new Error('503'))
    net.gates[1]?.resolve()
    await microtasks()

    expect(outbox.pending).toEqual(['A1'])
    expect(outbox.failed.map((f) => f.key)).toEqual(['A1'])
  })

  it('does not fire a request per keystroke while an endpoint is failing', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const net = fakeNetwork()
    const failEverything = (
      value: unknown,
      key: string,
      attempt: WriteBehindAttempt,
    ): Promise<void> => {
      const promise = net.write(value, key, attempt)
      net.gates[net.gates.length - 1]?.reject(new Error('503'))
      return promise
    }
    // A backoff five intervals long, so "nothing was sent" cannot be an
    // accident of the timer grid: with the backoff gone the next 1000ms tick
    // would send, and this test would see it.
    inScope(() =>
      useWriteBehind(cells, { write: failEverything, retry: { initialDelay: 5000 } }),
    )

    cells.A1 = 'a'
    await tick() // first attempt at t=1000, next due at t=6000

    for (const value of ['b', 'c', 'd', 'e']) {
      cells.A1 = value
      await nextTick()
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(net.calls).toHaveLength(1) // four keystrokes, four ticks, no request

    await vi.advanceTimersByTimeAsync(900) // t=5900
    expect(net.calls).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(100) // t=6000 — the backoff is up
    expect(net.values()).toEqual(['a', 'e']) // and it carries the newest value
  })

  it('honours the retry curve even when the interval is longer than the delay', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const net = fakeNetwork()
    const failEverything = (
      value: unknown,
      key: string,
      attempt: WriteBehindAttempt,
    ): Promise<void> => {
      const promise = net.write(value, key, attempt)
      net.gates[net.gates.length - 1]?.reject(new Error('503'))
      return promise
    }
    inScope(() =>
      useWriteBehind(cells, {
        write: failEverything,
        interval: 500,
        retry: { initialDelay: 100, factor: 2 },
      }),
    )

    cells.A1 = 'edited'
    await tick(3000)

    const times = net.times()
    const gaps = times.slice(1).map((at, index) => at - (times[index] ?? 0))
    // 0.1.0 rounded every attempt up to the next 500ms tick, so a curve
    // shorter than the interval was flat: 500/500/500 instead of 100/200/400.
    expect(gaps.slice(0, 4)).toEqual([100, 200, 400, 800])
  })
})

describe('the debounce is the user\'s, not the network\'s', () => {
  it('a response landing while the user types does not cancel the quiet period', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'v0' })
    const net = fakeNetwork()
    inScope(() => useWriteBehind(cells, { write: net.write, debounce: 2000 }))

    cells.A1 = 'first'
    await tick(2000) // the quiet period expires and the write goes out at t=2000
    expect(net.calls).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(303) // t=2303 — a keystroke, request still out
    cells.A1 = 'second'
    await nextTick()
    net.gates[0]?.resolve() // the superseded response lands mid-typing
    await microtasks()

    // 0.1.0 zeroed the debounce here and shipped the next write ~700ms later.
    await vi.advanceTimersByTimeAsync(1990) // t=4293, quiet period runs to t=4303
    expect(net.calls).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(20)
    expect(net.values()).toEqual(['first', 'second'])
  })

  it('retry() does not cut short the quiet period of a key being typed into', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'v0' })
    const net = fakeNetwork()
    const { value: outbox } = inScope(() =>
      useWriteBehind(cells, { write: net.write, debounce: 3000 }),
    )

    cells.A1 = 'mid-typing'
    await nextTick()
    outbox.retry() // clears backoffs; this key has none, it is simply being typed into

    await tick(2900)
    expect(net.calls).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(100)
    expect(net.values()).toEqual(['mid-typing'])
  })
})

describe('flush() sends what it says it sends', () => {
  it('sends a key parked by retry: false — the tab-hidden save depends on it', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'v0' })
    const net = fakeNetwork()
    const { value: outbox } = inScope(() =>
      useWriteBehind(cells, { write: net.write, retry: false }),
    )

    cells.A1 = 'edited'
    await tick()
    net.gates[0]?.reject(new Error('503'))
    await microtasks()
    expect(outbox.pending).toEqual(['A1'])
    expect(outbox.failed[0]?.retryAt).toBeUndefined() // parked forever

    // The server is back. 0.1.0 resolved this promise having sent nothing.
    const done = outbox.flush()
    expect(net.values()).toEqual(['edited', 'edited'])
    net.gates[1]?.resolve()
    await done

    expect(outbox.pending).toEqual([])
    expect(outbox.failed).toEqual([])
  })

  it('the tab-hidden flush revives a parked key too', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'v0' })
    const net = fakeNetwork()
    inScope(() => useWriteBehind(cells, { write: net.write, retry: false }))

    cells.A1 = 'edited'
    await tick()
    net.gates[0]?.reject(new Error('503'))
    await microtasks()

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await microtasks()
    vi.restoreAllMocks()

    expect(net.calls).toHaveLength(2)
  })
})

describe('the store only changes when the state does', () => {
  it('does not re-notify a pending watcher through a retry storm', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'v0' })
    const failEverything = (): Promise<void> => Promise.reject(new Error('503'))
    const { value: outbox } = inScope(() => useWriteBehind(cells, failEverything))

    const pendingSeen: string[][] = []
    inScope(() =>
      watch(
        () => outbox.pending,
        (keys) => pendingSeen.push([...keys]),
        { flush: 'sync' },
      ),
    )

    cells.A1 = 'edited'
    await tick(20000) // several attempts, all failing

    expect(outbox.failed[0]?.attempts).toBeGreaterThan(2)
    // `pending` has been ['A1'] since the first keystroke and never moved.
    // The README's own localStorage recipe writes on every one of these.
    expect(pendingSeen).toEqual([['A1']])
  })

  it('does not re-notify a failed watcher while an unrelated key churns', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'a', B2: 'b' })
    const net = fakeNetwork()
    const write = (value: unknown, key: string, attempt: WriteBehindAttempt): Promise<void> => {
      if (key === 'A1') return Promise.reject(new Error('503'))
      return net.write(value, key, attempt)
    }
    const { value: outbox } = inScope(() =>
      // A backoff far longer than the run, so A1's failure record is genuinely
      // unchanging: same attempts, same error, same retryAt.
      useWriteBehind(cells, { write, retry: { initialDelay: 600000 } }),
    )

    const failedSeen: number[] = []
    inScope(() =>
      watch(
        () => outbox.failed,
        (failed) => failedSeen.push(failed.length),
        { flush: 'sync' },
      ),
    )

    cells.A1 = 'fails'
    await tick()
    expect(outbox.failed).toHaveLength(1)

    // Now churn a healthy sibling: set → take → settle, three transitions each.
    for (const value of ['b1', 'b2', 'b3']) {
      cells.B2 = value
      await tick()
      net.gates[net.gates.length - 1]?.resolve()
      await microtasks()
    }

    expect(net.calls).toHaveLength(3)
    expect(failedSeen).toEqual([1]) // one change: A1 failing. Nothing since.
  })

  it('a backwards clock adjustment does not strand a queued write', async () => {
    vi.setSystemTime(1_000_000)
    const cells = reactive<Record<string, string>>({ A1: 'v0' })
    const net = fakeNetwork()
    inScope(() => useWriteBehind(cells, { write: net.write, debounce: 5000 }))

    cells.A1 = 'edited' // due at 1_005_000; the scheduler sleeps until then
    await nextTick()
    await vi.advanceTimersByTimeAsync(4000)

    // The OS moves the clock back 3s. The pending wake-up still fires on its
    // original countdown, but by the wall clock the key is not due yet — and
    // nothing else is going to happen unless that tick re-arms the wake-up.
    vi.setSystemTime(1_001_000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(net.calls).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(4000)
    expect(net.values()).toEqual(['edited'])
  })

  it('rebuilds the store once for a bulk edit, not once per key', async () => {
    const cells = reactive<Record<string, string>>({})
    const net = fakeNetwork()
    const { value: outbox } = inScope(() => useWriteBehind(cells, net.write))

    let rebuilds = 0
    inScope(() =>
      watch(
        () => outbox.pending,
        () => {
          rebuilds += 1
        },
        { flush: 'sync' },
      ),
    )

    for (let i = 0; i < 200; i += 1) cells[`cell-${i}`] = 'pasted'
    await nextTick()

    expect(outbox.pending).toHaveLength(200)
    expect(rebuilds).toBe(1)
  })
})

describe('the reactive store', () => {
  it('drives an effect as it changes', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const net = fakeNetwork()
    const { value: outbox } = inScope(() => useWriteBehind(cells, net.write))

    const seen: boolean[] = []
    inScope(() => watchEffect(() => seen.push(outbox.isSyncing)))
    expect(seen).toEqual([false])

    cells.A1 = 'edited'
    await tick()
    expect(outbox.isSyncing).toBe(true)

    net.gates[0]?.resolve()
    await microtasks()
    await nextTick()

    expect(seen).toEqual([false, true, false])
  })

  it('reports pending as every unconfirmed key, in-flight ones included', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'a', B2: 'b' })
    const net = fakeNetwork()
    const { value: outbox } = inScope(() => useWriteBehind(cells, net.write))

    cells.A1 = 'a-edited'
    await tick()
    cells.B2 = 'b-edited'
    await nextTick()

    expect(outbox.pending).toEqual(['A1', 'B2'])
    expect(outbox.inFlight).toEqual(['A1'])
    expect(outbox.isSyncing).toBe(true)
  })
})

describe('the timer', () => {
  it('does not run before anything is dirty', () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    inScope(() => useWriteBehind(cells, () => Promise.resolve()))

    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops again once the outbox is clean', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const net = fakeNetwork()
    inScope(() => useWriteBehind(cells, net.write))

    cells.A1 = 'edited'
    await nextTick()
    expect(vi.getTimerCount()).toBe(1)

    await tick()
    net.gates[0]?.resolve()
    await microtasks()

    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops on scope dispose and sends nothing afterwards', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const net = fakeNetwork()
    const { scope } = inScope(() => useWriteBehind(cells, net.write))

    cells.A1 = 'edited'
    await nextTick()
    scope.stop()

    await vi.advanceTimersByTimeAsync(10000)

    expect(net.calls).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('flush()', () => {
  it('sends immediately, including an edit made in the same tick', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const net = fakeNetwork()
    const { value: outbox } = inScope(() => useWriteBehind(cells, net.write))

    cells.A1 = 'typed-and-saved-at-once'
    const done = outbox.flush()

    expect(net.values()).toEqual(['typed-and-saved-at-once'])

    net.gates[0]?.resolve()
    await done
    expect(outbox.pending).toEqual([])
  })

  it('resolves even though a key edited during the flight is still pending', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const net = fakeNetwork()
    const { value: outbox } = inScope(() => useWriteBehind(cells, net.write))

    cells.A1 = 'first'
    const done = outbox.flush()
    cells.A1 = 'second'
    await nextTick()
    net.gates[0]?.resolve()
    await done

    expect(outbox.pending).toEqual(['A1'])
  })

  it('ignores the debounce clock', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const net = fakeNetwork()
    const { value: outbox } = inScope(() =>
      useWriteBehind(cells, { write: net.write, debounce: 60000 }),
    )

    cells.A1 = 'edited'
    const done = outbox.flush()
    expect(net.values()).toEqual(['edited'])

    net.gates[0]?.resolve()
    await done
    expect(outbox.pending).toEqual([])
  })
})

describe('set(), retry() and discard()', () => {
  it('set() writes local state and queues in one call', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const net = fakeNetwork()
    const { value: outbox } = inScope(() => useWriteBehind(cells, net.write))

    outbox.set('A1', 'via-set')

    expect(cells.A1).toBe('via-set')
    await tick()
    expect(net.values()).toEqual(['via-set'])
  })

  it('set() queues an object mutated in place, which `equals` cannot see', async () => {
    const cells = reactive<Record<string, { text: string }>>({ A1: { text: 'foo' } })
    const net = fakeNetwork()
    const { value: outbox } = inScope(() => useWriteBehind(cells, net.write))

    const cell = cells.A1
    if (!cell) throw new Error('missing cell')
    cell.text = 'mutated in place'
    await tick()
    expect(net.calls).toHaveLength(0) // documented: Object.is cannot see this

    outbox.set('A1', cell)
    await tick()
    expect(net.calls).toHaveLength(1)
  })

  it('retry() clears the backoff so the key goes out on the next tick', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const net = fakeNetwork()
    const { value: outbox } = inScope(() => useWriteBehind(cells, net.write))

    cells.A1 = 'edited'
    await tick()
    net.gates[0]?.reject(new Error('503'))
    await microtasks()
    expect(outbox.failed).toHaveLength(1)

    outbox.retry('A1')
    expect(outbox.failed).toEqual([])

    await vi.advanceTimersByTimeAsync(1000)
    expect(net.calls).toHaveLength(2)
  })

  it('discard() is the only thing that loses a write', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const net = fakeNetwork()
    const { value: outbox } = inScope(() => useWriteBehind(cells, net.write))

    cells.A1 = 'edited'
    await nextTick()
    expect(outbox.pending).toEqual(['A1'])

    outbox.discard('A1')

    expect(outbox.pending).toEqual([])
    await tick(10000)
    expect(net.calls).toEqual([])
  })

  it('keeps a queued write for a key deleted from the source', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const net = fakeNetwork()
    const { value: outbox } = inScope(() => useWriteBehind(cells, net.write))

    cells.A1 = 'edited'
    await nextTick()
    delete cells.A1
    await nextTick()

    expect(outbox.pending).toEqual(['A1'])
    await tick()
    expect(net.values()).toEqual(['edited'])
  })
})

describe('options', () => {
  it('interval sets the cadence', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const net = fakeNetwork()
    inScope(() => useWriteBehind(cells, { write: net.write, interval: 5000 }))

    cells.A1 = 'edited'
    await tick(4999)
    expect(net.calls).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    expect(net.calls).toHaveLength(1)
  })

  it('debounce holds a key back until the typing stops', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const net = fakeNetwork()
    inScope(() => useWriteBehind(cells, { write: net.write, debounce: 2500 }))

    cells.A1 = 'a'
    await tick(1000)
    expect(net.calls).toHaveLength(0)

    cells.A1 = 'b' // pushes the quiet period out again
    await tick(2000)
    expect(net.calls).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(2000)
    expect(net.values()).toEqual(['b'])
  })

  it('retry: false parks a failed key instead of retrying or dropping it', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const net = fakeNetwork()
    const { value: outbox } = inScope(() =>
      useWriteBehind(cells, { write: net.write, retry: false }),
    )

    cells.A1 = 'edited'
    await tick()
    net.gates[0]?.reject(new Error('503'))
    await microtasks()

    await vi.advanceTimersByTimeAsync(120000)
    expect(net.calls).toHaveLength(1)
    expect(outbox.pending).toEqual(['A1'])
    expect(outbox.failed[0]?.retryAt).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)

    outbox.retry('A1')
    await vi.advanceTimersByTimeAsync(1000)
    expect(net.calls).toHaveLength(2)
  })

  it('keys narrows what the watcher picks up', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'a', B2: 'b' })
    const net = fakeNetwork()
    inScope(() => useWriteBehind(cells, { write: net.write, keys: ['A1'] }))

    cells.A1 = 'a-edited'
    cells.B2 = 'b-edited'
    await tick()

    expect(net.keys()).toEqual(['A1'])
  })

  it('keys accepts a predicate', async () => {
    const cells = reactive<Record<string, string>>({ 'draft:1': 'a', 'saved:1': 'b' })
    const net = fakeNetwork()
    inScope(() =>
      useWriteBehind(cells, { write: net.write, keys: (key) => key.startsWith('draft:') }),
    )

    cells['draft:1'] = 'edited'
    cells['saved:1'] = 'edited'
    await tick()

    expect(net.keys()).toEqual(['draft:1'])
  })

  it('equals decides what counts as an edit', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const net = fakeNetwork()
    inScope(() =>
      useWriteBehind(cells, {
        write: net.write,
        equals: (a, b) => a.trim() === b.trim(),
      }),
    )

    cells.A1 = '  foo  '
    await tick()
    expect(net.calls).toHaveLength(0)

    cells.A1 = 'bar'
    await tick()
    expect(net.values()).toEqual(['bar'])
  })
})

/**
 * Every one of these behaviours belongs to the engine, and none of it is
 * reimplemented here — that is the point of the split, so what these cases
 * prove is that the composable inherits it rather than intercepting it.
 */
describe('flush when the page goes away', () => {
  const hide = async (): Promise<void> => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await microtasks()
  }

  afterEach(() => vi.restoreAllMocks())

  it('flushes on pagehide too — a refresh, or an iOS swipe-away', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const net = fakeNetwork()
    inScope(() => useWriteBehind(cells, net.write))

    cells.A1 = 'edited'
    await nextTick()
    window.dispatchEvent(new Event('pagehide'))
    await microtasks()

    expect(net.values()).toEqual(['edited'])
  })

  it('tells the writer the page is going away, so it can set keepalive', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const net = fakeNetwork()
    inScope(() => useWriteBehind(cells, net.write))

    cells.A1 = 'edited'
    await nextTick()
    await hide()

    expect(net.reasons()).toEqual(['unload'])
    expect(net.finals()).toEqual([true])
  })

  it("flush('unload') says the same thing by hand", async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const net = fakeNetwork()
    const { value: outbox } = inScope(() =>
      useWriteBehind(cells, { write: net.write, flushOnHidden: false }),
    )

    cells.A1 = 'edited'
    await nextTick()
    void outbox.flush('unload')
    await microtasks()

    expect(net.reasons()).toEqual(['unload'])
    expect(net.finals()).toEqual([true])
  })

  it('calls an ordinary flush() manual', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const net = fakeNetwork()
    const { value: outbox } = inScope(() => useWriteBehind(cells, net.write))

    cells.A1 = 'edited'
    await nextTick()
    void outbox.flush()
    await microtasks()

    expect(net.reasons()).toEqual(['manual'])
    expect(net.finals()).toEqual([false])
  })

  it('drops the pagehide listener with the scope', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const net = fakeNetwork()
    const { scope } = inScope(() => useWriteBehind(cells, net.write))

    cells.A1 = 'edited'
    await nextTick()
    scope.stop()
    window.dispatchEvent(new Event('pagehide'))
    await microtasks()

    expect(net.calls).toEqual([])
  })

  it('flushes what is pending, without waiting for the interval', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const net = fakeNetwork()
    inScope(() => useWriteBehind(cells, net.write))

    cells.A1 = 'edited'
    await nextTick()
    await hide()

    expect(net.values()).toEqual(['edited'])
  })

  it('ignores a visibilitychange that is not "hidden"', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const net = fakeNetwork()
    inScope(() => useWriteBehind(cells, net.write))

    cells.A1 = 'edited'
    await nextTick()
    document.dispatchEvent(new Event('visibilitychange'))
    await microtasks()

    expect(net.calls).toEqual([])
  })

  it('opts out with flushOnHidden: false', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const net = fakeNetwork()
    inScope(() => useWriteBehind(cells, { write: net.write, flushOnHidden: false }))

    cells.A1 = 'edited'
    await nextTick()
    await hide()

    expect(net.calls).toEqual([])
  })

  it('stops listening once the scope is disposed', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const net = fakeNetwork()
    const { scope } = inScope(() => useWriteBehind(cells, net.write))

    cells.A1 = 'edited'
    await nextTick()
    scope.stop()
    await hide()

    expect(net.calls).toEqual([])
  })
})

describe('the batch writer', () => {
  it('sends every due key in one call', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'a', B2: 'b' })
    const calls: [string, string][][] = []
    const { value: outbox } = inScope(() =>
      useWriteBehind(cells, {
        flush: (entries) => {
          calls.push(entries)
        },
      }),
    )

    cells.A1 = 'a-edited'
    cells.B2 = 'b-edited'
    await tick()

    expect(calls).toEqual([
      [
        ['A1', 'a-edited'],
        ['B2', 'b-edited'],
      ],
    ])
    expect(outbox.pending).toEqual([])
  })

  it('keeps the whole batch pending when the call throws', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'a', B2: 'b' })
    const { value: outbox } = inScope(() =>
      useWriteBehind(cells, { flush: () => Promise.reject(new Error('500')) }),
    )

    cells.A1 = 'a-edited'
    cells.B2 = 'b-edited'
    await tick()

    expect(outbox.pending).toEqual(['A1', 'B2'])
    expect(outbox.failed).toHaveLength(2)
  })

  it('fails only the keys the call names', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'a', B2: 'b' })
    const { value: outbox } = inScope(() =>
      useWriteBehind(cells, { flush: () => ({ failed: ['B2'] }) }),
    )

    cells.A1 = 'a-edited'
    cells.B2 = 'b-edited'
    await tick()

    expect(outbox.pending).toEqual(['B2'])
    expect(outbox.failed.map((failure) => failure.key)).toEqual(['B2'])
  })
})

describe('typing', () => {
  it('infers the value type from the source', async () => {
    const counters = reactive<Record<string, number>>({ visits: 1 })
    const seen: number[] = []
    const outbox: WriteBehind<number> = inScope(() =>
      useWriteBehind(counters, (value) => {
        seen.push(value)
      }),
    ).value

    outbox.set('visits', 2)
    await tick()

    expect(seen).toEqual([2])
  })
})
