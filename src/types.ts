/**
 * Public types.
 *
 * Leaf module: imports nothing at runtime (the single `import type { Ref }`
 * is erased at compile time), so it can be copied on its own.
 */
import type { Ref } from 'vue'

/** Outbox keys are plain strings — the keys of the reactive record you pass in. */
export type WriteBehindKey = string

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
 * Per-key writer — the common form.
 *
 * Called with the value read out of the outbox **at send time**, never a value
 * captured when the edit happened. Reject (or throw) to fail the key; the
 * return value is otherwise ignored on purpose — the server's reply never
 * touches local state.
 */
export type WriteBehindWriter<T> = (value: T, key: WriteBehindKey) => unknown

/** What a batch writer may resolve to in order to fail part of the batch. */
export interface WriteBehindBatchOutcome {
  /** Keys the server did not accept. Everything else in the batch is treated as written. */
  failed?: readonly WriteBehindKey[]
}

/**
 * Batch writer — one call for every due key.
 *
 * Throw/reject and the **whole batch** stays pending. Resolve with
 * `{ failed: [...] }` to fail part of it. Resolve with anything else (including
 * `undefined`) and the whole batch is treated as written.
 */
export type WriteBehindBatchWriter<T> = (
  entries: [WriteBehindKey, T][],
) => WriteBehindBatchOutcome | void | Promise<WriteBehindBatchOutcome | void>

/** Per-key exponential backoff. Defaults produce 1s → 2 → 4 → 8 → 16 → 30s, capped. */
export interface WriteBehindRetryOptions {
  /** Delay after the first failure, in ms. Default `1000`. */
  initialDelay?: number
  /** Ceiling for the delay, in ms. Default `30000`. */
  maxDelay?: number
  /** Multiplier applied per consecutive failure. Default `2`. */
  factor?: number
}

/** One key's latest failure. Only the newest error per key is kept. */
export interface WriteBehindFailure {
  key: WriteBehindKey
  /** Whatever the writer rejected with. */
  error: unknown
  /** Consecutive failures — resets on success, on `retry()`, and on `discard()`. */
  attempts: number
  /**
   * Epoch ms of the next automatic attempt, or `undefined` when no automatic
   * attempt is scheduled (`retry: false`) — that key needs an edit or an
   * explicit `retry(key)`.
   */
  retryAt: number | undefined
}

/** Options shared by both writer shapes. Every one of them is an opt-*out*. */
export interface WriteBehindBaseOptions<T> {
  /** Flush cadence in ms. Default `1000`. The timer only runs while work is queued. */
  interval?: number
  /**
   * Per-key quiet period in ms before a key becomes eligible. Default `0`
   * (the `interval` already coalesces a burst of edits into one write).
   * An edit never *shortens* an active backoff.
   */
  debounce?: number
  /**
   * Retry policy, or `false` to stop retrying a key after a failure. Retrying
   * is the default because dropping a user's edit is the one unacceptable
   * outcome. With `false` the key stays pending and listed in `failed` — it is
   * never discarded — until the next edit or an explicit `retry(key)`.
   */
  retry?: WriteBehindRetryOptions | false
  /**
   * Flush when the tab is hidden (`visibilitychange`). Default `true`.
   * Best-effort only: the browser may kill the page before the request leaves.
   */
  flushOnHidden?: boolean
  /**
   * Narrows what the source watcher picks up. An allow-list or a predicate.
   * Default: every key. `set()` is explicit and ignores this filter.
   */
  keys?: readonly WriteBehindKey[] | ((key: WriteBehindKey) => boolean)
  /**
   * Change detection for a key's value. Default `Object.is`.
   *
   * With the default, mutating an object value **in place** is not an edit —
   * replace the object, or call `set(key, value)`.
   */
  equals?: (a: T, b: T) => boolean
}

/**
 * Options for `useWriteBehind`. Exactly one writer: `write` (per key) or
 * `flush` (batched).
 */
export type WriteBehindOptions<T> = WriteBehindBaseOptions<T> &
  (
    | { write: WriteBehindWriter<T>; flush?: undefined }
    | { write?: undefined; flush: WriteBehindBatchWriter<T> }
  )

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
  /** The subset of `pending` currently in flight. */
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
   * `debounce` and backoff clocks. Resolves when the requests it started have
   * settled — keys edited *during* that flight are still pending afterwards.
   */
  flush: () => Promise<void>
  /**
   * Clear the backoff (and the recorded failure) for one key, or all of them,
   * so they go out on the next tick. The only way to revive a key that failed
   * under `retry: false`.
   */
  retry: (key?: WriteBehindKey) => void
  /**
   * Drop a key's pending write. **The only operation in this library that
   * loses a write** — nothing else ever discards one.
   */
  discard: (key: WriteBehindKey) => void
}
