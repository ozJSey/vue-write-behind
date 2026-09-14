/**
 * SSR safety suite.
 *
 * Runs in vitest's `environment: 'node'` (no jsdom, no `window`, no
 * `document`) against the published entry barrel, to prove:
 *   - the package imports with no top-level DOM access,
 *   - the composable runs server-side without throwing,
 *   - and above all that **no timer is ever started there** — an SSR render
 *     that leaves an interval behind holds the response open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, reactive } from 'vue'
import { useWriteBehind } from './vueWriteBehind'
import type { WriteBehind, WriteBehindFailure, WriteBehindOptions } from './vueWriteBehind'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('SSR safety — node environment', () => {
  it('has no DOM globals to accidentally touch', () => {
    expect(typeof globalThis.window).toBe('undefined')
    expect(typeof globalThis.document).toBe('undefined')
    expect(typeof useWriteBehind).toBe('function')
  })

  it('never starts the flush timer', async () => {
    const cells = reactive<Record<string, string>>({ A1: 'foo' })
    const scope = effectScope()
    const calls: string[] = []

    const outbox = scope.run(() =>
      useWriteBehind(cells, (value: string) => {
        calls.push(value)
      }),
    )

    cells.A1 = 'edited-during-ssr'
    await nextTick()

    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60000)
    expect(calls).toEqual([])

    // The edit sits in this render's outbox and goes nowhere. That queue is a
    // closure inside the render's effect scope: hydration builds a NEW
    // composable with a NEW outbox and cannot see it, and nothing here
    // serialises it. A server-side edit does not reach the client — send it
    // from the client, or put it in your own payload.
    expect(outbox?.pending).toEqual(['A1'])
    scope.stop()
  })

  it('exposes the public types', () => {
    const options: WriteBehindOptions<string> = { write: () => undefined, interval: 250 }
    const failure: WriteBehindFailure = { key: 'A1', error: undefined, attempts: 0, retryAt: 1 }
    const store: WriteBehind<string> | undefined = effectScope().run(() =>
      useWriteBehind(reactive<Record<string, string>>({}), options),
    )

    expect(failure.key).toBe('A1')
    expect(store?.isSyncing).toBe(false)
  })
})
