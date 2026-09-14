/**
 * Public types.
 *
 * Most of them are the engine's and are re-exported unchanged, so a consumer
 * imports one set of names from one package and never has to reach past this
 * one. Two are Vue's own and live here:
 *
 *   - `WriteBehindSource` — a `ref()` is a source shape the engine cannot know
 *     about.
 *   - `WriteBehind` — the reactive store this package returns. It is the
 *     engine's surface minus the three members Vue answers for you (`sync` is
 *     the source watcher's job, `subscribe` is what `shallowReactive` replaces,
 *     and `dispose` belongs to the effect scope).
 *
 * Leaf module: every import here is erased at compile time.
 */
import type { Ref } from 'vue'
import type {
  WriteBehindFailure,
  WriteBehindKey,
  WriteBehindReason,
} from '@ozjsey/write-behind'

export type {
  WriteBehindAttempt,
  WriteBehindBaseOptions,
  WriteBehindBatchOutcome,
  WriteBehindBatchWriter,
  WriteBehindFailure,
  WriteBehindKey,
  WriteBehindOptions,
  WriteBehindReason,
  WriteBehindRetryOptions,
  WriteBehindWriter,
} from '@ozjsey/write-behind'

/**
 * The record whose keys are written back. Either a `reactive()` object or a
 * `ref()` holding a plain object.
 *
 * **Precondition — keys are independent.** Everything in this library relies on
 * it: writes go out in parallel, in no particular order, last-write-wins per
 * key. If key `b` is only valid once key `a` has landed, this is the wrong tool
 * (that needs an ordered operation log — see the README's refuse list).
 */
export type WriteBehindSource<T> = Record<WriteBehindKey, T> | Ref<Record<WriteBehindKey, T>>

/**
 * The reactive store `useWriteBehind` returns. Read the fields straight in a
 * template; they are recomputed on every state change.
 */
export interface WriteBehind<T> {
  /**
   * Every key with an unsaved change, **including** the ones currently on the
   * wire. This is the "you have unsaved work" number.
   */
  readonly pending: readonly WriteBehindKey[]
  /**
   * The subset of `pending` whose write is currently on the wire. A key held
   * back by a *discarded* write's request is not in it — see `discard`.
   */
  readonly inFlight: readonly WriteBehindKey[]
  /** Latest failure per failing key. */
  readonly failed: readonly WriteBehindFailure[]
  /** `true` while anything is in flight. */
  readonly isSyncing: boolean
  /**
   * Write a value into the source **and** queue it. Always queues, even when
   * the value is unchanged — the escape hatch for values `equals` cannot see
   * (an object mutated in place) and for keys excluded by `keys`.
   */
  set: (key: WriteBehindKey, value: T) => void
  /**
   * Send every pending key that is not already in flight, ignoring the
   * `debounce` clock, the retry backoff **and** `retry: false`'s parked state.
   * A key already on the wire is the one thing it cannot send: a request cannot
   * be recalled, and a second one could land out of order.
   *
   * Resolves when the requests it started have settled — it never rejects, and
   * resolving is not proof of success. Read `pending` / `failed` afterwards to
   * see what landed; keys edited *during* the flight are still pending.
   *
   * Pass `'unload'` to tell the writer the page is going away, exactly as the
   * automatic flush on `visibilitychange`/`pagehide` does — the escape hatch
   * for a signal the engine refuses to listen to itself, such as a router
   * leave guard.
   */
  flush: (reason?: Exclude<WriteBehindReason, 'scheduled'>) => Promise<void>
  /**
   * Clear the retry backoff (and the recorded failure) for one key, or all of
   * them, so they go out on the next tick. Revives a key parked by
   * `retry: false`. It does not touch a `debounce` quiet period — that belongs
   * to the user's typing, not to the failure.
   */
  retry: (key?: WriteBehindKey) => void
  /**
   * Drop a key's pending write. **The only operation in this library that
   * loses a write** — nothing else ever discards one.
   *
   * A request already on the wire for that key cannot be recalled: its result
   * is ignored, but the key stays reserved until it answers, so a write queued
   * in the meantime can never race it and land out of order. While that lasts
   * the key is in `pending` and not in `inFlight`.
   */
  discard: (key: WriteBehindKey) => void
}
