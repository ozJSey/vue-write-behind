/**
 * The Vue surface — watches the source record, mirrors the outbox into a
 * reactive store, and owns when the clock runs.
 *
 * It reads local state and never writes it back: nothing here applies a server
 * response to the source, because the whole point is that the cell the user is
 * typing in cannot be overwritten from the network.
 *
 * This module owns the library's single `Date.now()` call site (`now` below).
 * Everything under it — the outbox, the flusher, the scheduler — is handed the
 * reading rather than taking one.
 */
import { isRef, shallowReactive, watch } from 'vue'
import { createFlusher, type ResolvedWriter } from './flush'
import { isServer, onDispose, onTabHidden } from './lifecycle'
import { createOutbox } from './outbox'
import { createBackoff, createScheduler } from './scheduler'
import type {
  WriteBehind,
  WriteBehindFailure,
  WriteBehindKey,
  WriteBehindOptions,
  WriteBehindSource,
  WriteBehindWriter,
} from './types'

const DEFAULT_INTERVAL = 1000

/** The store as this module holds it: same shape, writable. */
type MutableWriteBehind<T> = { -readonly [K in keyof WriteBehind<T>]: WriteBehind<T>[K] }

const sameKeys = (a: readonly WriteBehindKey[], b: readonly WriteBehindKey[]): boolean =>
  a.length === b.length && a.every((key, index) => key === b[index])

const sameFailures = (
  a: readonly WriteBehindFailure[],
  b: readonly WriteBehindFailure[],
): boolean =>
  a.length === b.length &&
  a.every((failure, index) => {
    const other = b[index]
    return (
      other !== undefined &&
      failure.key === other.key &&
      failure.error === other.error &&
      failure.attempts === other.attempts &&
      failure.retryAt === other.retryAt
    )
  })

/**
 * Write-behind cache for a reactive record. Local state stays authoritative;
 * the writer's result is discarded on purpose.
 *
 * @example
 * ```ts
 * const cells = reactive<Record<string, string>>({ A1: 'foo' })
 * const outbox = useWriteBehind(cells, (value, key) => api.put(`/cell/${key}`, value))
 * cells.A1 = 'bar' // that is the whole API
 * ```
 *
 * @param source A `reactive()` record (or a `ref()` holding one). Its keys must
 *   be independent of each other — writes go out in parallel, last-write-wins.
 * @param writerOrOptions The per-key writer, or an options object carrying
 *   either `write` (per key) or `flush` (batched).
 */
export function useWriteBehind<T>(
  source: WriteBehindSource<T>,
  writerOrOptions: WriteBehindWriter<T> | WriteBehindOptions<T>,
): WriteBehind<T> {
  const options: WriteBehindOptions<T> =
    typeof writerOrOptions === 'function' ? { write: writerOrOptions } : writerOrOptions

  const writer: ResolvedWriter<T> = options.flush
    ? { flush: options.flush }
    : { write: options.write }

  const interval = options.interval ?? DEFAULT_INTERVAL
  const debounce = options.debounce ?? 0
  const equals = options.equals ?? Object.is
  const keys = options.keys
  const tracked: (key: WriteBehindKey) => boolean =
    keys === undefined
      ? () => true
      : typeof keys === 'function'
        ? keys
        : (key) => keys.includes(key)

  /** The one clock in the library. Every module below is handed its reading. */
  const now = (): number => Date.now()
  /** The debounce deadline for an edit happening right now. */
  const readyAt = (): number => (debounce > 0 ? now() + debounce : 0)

  const outbox = createOutbox<T>({
    retryDelay: createBackoff(options.retry),
    onChange: () => onOutboxChange(),
  })
  const flusher = createFlusher<T>({ outbox, writer, now })
  const scheduler = createScheduler({
    interval,
    onTick: () => {
      flusher.dispatch()
      // A tick that sent nothing produces no outbox transition, so the next
      // wake-up has to be re-armed here rather than from onChange alone.
      reschedule()
    },
  })

  const readSource = (): Record<WriteBehindKey, T> => (isRef(source) ? source.value : source)

  // Last value seen per key. Boxed so `T` may legitimately be `undefined`
  // without `has`/`get` disagreeing.
  const shadow = new Map<WriteBehindKey, { value: T }>()
  for (const [key, value] of Object.entries(readSource())) {
    if (!tracked(key)) continue
    // Seeded, NOT queued: whatever the record starts with came from the server.
    shadow.set(key, { value })
  }

  const syncFromSource = (): void => {
    const current = readSource()
    const deadline = readyAt()
    // One notification for the whole sweep: a 2000-key paste used to rebuild
    // the store's three arrays 2000 times.
    outbox.batch(() => {
      for (const [key, value] of Object.entries(current)) {
        if (!tracked(key)) continue
        const seen = shadow.get(key)
        if (seen && equals(seen.value, value)) continue
        shadow.set(key, { value })
        outbox.set(key, value, deadline)
      }
    })
    // A key deleted from the source stops being watched, but its queued write
    // survives — losing it silently is the one outcome this library refuses.
    // `discard(key)` is how a consumer drops it on purpose.
    for (const key of shadow.keys()) {
      if (!(key in current)) shadow.delete(key)
    }
  }

  const store = shallowReactive<MutableWriteBehind<T>>({
    pending: [],
    inFlight: [],
    failed: [],
    isSyncing: false,
    set: (key, value) => {
      readSource()[key] = value
      shadow.set(key, { value })
      // Unconditional: `set` is the escape hatch for a change `equals` cannot
      // see (an object mutated in place) and for keys `keys` filters out.
      outbox.set(key, value, readyAt())
    },
    flush: () => {
      // The source watcher is a `pre` watcher, so an edit made in this tick has
      // not been picked up yet — read it now or a save button next to an input
      // would miss the last keystroke.
      syncFromSource()
      return flusher.flush()
    },
    retry: (key) => outbox.clearBackoff(key),
    discard: (key) => outbox.discard(key),
  })

  const syncStore = (): void => {
    const pending = outbox.pendingKeys()
    const inFlight = outbox.inFlightKeys()
    const failed = outbox.failures(now())
    // Reassigning an equal array would still change its identity, and a
    // consumer `watch(() => outbox.pending, …)` — the README's own persistence
    // recipe — would re-fire on every transition that changed nothing.
    if (!sameKeys(store.pending, pending)) store.pending = pending
    if (!sameKeys(store.inFlight, inFlight)) store.inFlight = inFlight
    if (!sameFailures(store.failed, failed)) store.failed = failed
    store.isSyncing = inFlight.length > 0
  }

  /**
   * Run the interval only while something is actually eligible, and arm a
   * one-shot for the next deadline that is not. Never on the server, and never
   * left running with nothing to send — an idle app must not hold the event
   * loop open.
   */
  function reschedule(): void {
    if (isServer()) return
    const at = now()
    if (outbox.hasWorkDueBy(at)) scheduler.start()
    else scheduler.stop()
    scheduler.wakeAt(outbox.nextDeadline(at), at)
  }

  function onOutboxChange(): void {
    syncStore()
    reschedule()
  }

  watch(readSource, syncFromSource, { deep: true })

  const stopHiddenListener =
    options.flushOnHidden === false ? () => {} : onTabHidden(() => void store.flush())

  onDispose(() => {
    scheduler.dispose()
    stopHiddenListener()
  })

  return store
}
