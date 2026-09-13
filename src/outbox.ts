/**
 * The outbox: the pure key/version/dirty state machine.
 *
 * No Vue, no timers, no I/O — every clock reading arrives as an argument. This
 * is where the whole library's correctness lives, which is why it is testable
 * without mounting anything.
 *
 * **Invariant: this module is the only place a dirty key is ever cleared.**
 * Everything else (scheduler, flush, the composable) can only ask.
 *
 * The rule that makes it correct: a key carries a **monotonic version**, and a
 * write records the version it was sent at. A success clears the key only when
 * the version has not moved since. A boolean dirty flag cannot express that —
 * the response would clear a flag a newer edit had set, and that edit would be
 * gone with nothing on screen to say so.
 */
import type { WriteBehindFailure, WriteBehindKey } from './types'

/** One entry handed to a writer. `value` is read out of the map at take time. */
export interface OutboxEntry<T> {
  key: WriteBehindKey
  value: T
  /**
   * The version this send is for. Hand it back to `settle`/`fail` — it is the
   * flight's identity, so a response from a superseded flight (the key was
   * discarded and re-queued, or `retry()` re-armed it) is ignored instead of
   * clearing the wrong write.
   */
  sentVersion: number
}

interface Entry<T> {
  value: T
  /** Bumped on every edit. Unique across the whole outbox, never reused. */
  version: number
  /** The version currently on the wire, or `undefined` when nothing is. */
  sentVersion: number | undefined
  /** Consecutive failures. */
  attempts: number
  error: unknown
  /** Epoch ms before which the key is not eligible. `0` = eligible now. */
  dueAt: number
  /** Failed with retries disabled: needs a fresh edit or an explicit retry. */
  blocked: boolean
}

export interface OutboxConfig {
  /**
   * Backoff for the n-th consecutive failure, in ms. Returning `undefined`
   * blocks the key instead of scheduling an attempt (`retry: false`).
   */
  retryDelay: (attempts: number) => number | undefined
  /** Called after every state transition. */
  onChange?: () => void
}

export interface Outbox<T> {
  /**
   * Queue a value. `dueAt` (epoch ms) holds the key back — used for `debounce`.
   * It can only ever push the key further out, never pull an active backoff in.
   */
  set: (key: WriteBehindKey, value: T, dueAt?: number) => void
  /**
   * Claim every key that is due at `now`, not in flight and not blocked,
   * marking each in flight. Pass `Infinity` to ignore the clocks (`flush()`).
   */
  take: (now: number) => OutboxEntry<T>[]
  /** The write landed. Clears the key **only if** its version has not moved. */
  settle: (key: WriteBehindKey, sentVersion: number) => void
  /** The write failed. Never clears the key. */
  fail: (key: WriteBehindKey, sentVersion: number, error: unknown, now: number) => void
  /** Forget a key's pending write entirely — the one operation that loses one. */
  discard: (key: WriteBehindKey) => void
  /** Make a key (or all of them) eligible again and forget its failure. */
  clearBackoff: (key?: WriteBehindKey) => void
  /** Every unconfirmed key, in-flight ones included. */
  pendingKeys: () => WriteBehindKey[]
  inFlightKeys: () => WriteBehindKey[]
  failures: () => WriteBehindFailure[]
  isEmpty: () => boolean
  /** True while some key could still become eligible — i.e. the clock is worth running. */
  hasScheduledWork: () => boolean
}

export function createOutbox<T>({ retryDelay, onChange }: OutboxConfig): Outbox<T> {
  const entries = new Map<WriteBehindKey, Entry<T>>()
  // One counter for the whole outbox rather than one per key: versions are then
  // never reused, so a response from a discarded flight can never be mistaken
  // for the current one on a key that was queued again in the meantime.
  let version = 0

  const notify = () => onChange?.()

  const set = (key: WriteBehindKey, value: T, dueAt = 0): void => {
    version += 1
    const entry = entries.get(key)
    if (entry) {
      entry.value = value
      entry.version = version
      // A new value is a new write, not a retry — it re-arms a blocked key…
      entry.blocked = false
      // …but it must not shorten an active backoff, or a user typing into a
      // failing endpoint would fire one request per keystroke.
      entry.dueAt = Math.max(entry.dueAt, dueAt)
    } else {
      entries.set(key, {
        value,
        version,
        sentVersion: undefined,
        attempts: 0,
        error: undefined,
        dueAt,
        blocked: false,
      })
    }
    notify()
  }

  const take = (now: number): OutboxEntry<T>[] => {
    const batch: OutboxEntry<T>[] = []
    for (const [key, entry] of entries) {
      if (entry.sentVersion !== undefined) continue // already on the wire (H5)
      if (entry.blocked) continue
      if (entry.dueAt > now) continue
      entry.sentVersion = entry.version
      batch.push({ key, value: entry.value, sentVersion: entry.version })
    }
    if (batch.length > 0) notify()
    return batch
  }

  const settle = (key: WriteBehindKey, sentVersion: number): void => {
    const entry = entries.get(key)
    if (!entry || entry.sentVersion !== sentVersion) return
    if (entry.version === sentVersion) {
      // Nothing was typed while this was in flight: the key is saved.
      entries.delete(key)
    } else {
      // It was. Keep it dirty and send the newer value next tick; the server is
      // evidently healthy, so drop the backoff.
      entry.sentVersion = undefined
      entry.attempts = 0
      entry.error = undefined
      entry.dueAt = 0
      entry.blocked = false
    }
    notify()
  }

  const fail = (key: WriteBehindKey, sentVersion: number, error: unknown, now: number): void => {
    const entry = entries.get(key)
    if (!entry || entry.sentVersion !== sentVersion) return
    entry.sentVersion = undefined
    entry.attempts += 1
    entry.error = error
    const delay = retryDelay(entry.attempts)
    if (delay === undefined) entry.blocked = true
    else entry.dueAt = now + delay
    notify()
  }

  const discard = (key: WriteBehindKey): void => {
    if (!entries.delete(key)) return
    notify()
  }

  const clearBackoff = (key?: WriteBehindKey): void => {
    const targets = key === undefined ? entries.values() : [entries.get(key)]
    for (const entry of targets) {
      if (!entry) continue
      entry.attempts = 0
      entry.error = undefined
      entry.dueAt = 0
      entry.blocked = false
    }
    notify()
  }

  const failures = (): WriteBehindFailure[] => {
    const list: WriteBehindFailure[] = []
    for (const [key, entry] of entries) {
      if (entry.attempts === 0) continue
      list.push({
        key,
        error: entry.error,
        attempts: entry.attempts,
        retryAt: entry.blocked ? undefined : entry.dueAt,
      })
    }
    return list
  }

  const hasScheduledWork = (): boolean => {
    for (const entry of entries.values()) {
      if (entry.sentVersion === undefined && !entry.blocked) return true
    }
    return false
  }

  return {
    set,
    take,
    settle,
    fail,
    discard,
    clearBackoff,
    pendingKeys: () => [...entries.keys()],
    inFlightKeys: () =>
      [...entries].filter(([, entry]) => entry.sentVersion !== undefined).map(([key]) => key),
    failures,
    isEmpty: () => entries.size === 0,
    hasScheduledWork,
  }
}
