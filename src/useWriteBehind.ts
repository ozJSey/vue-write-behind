/**
 * The Vue surface — watches the source record, mirrors the outbox into a
 * reactive store, and owns when the clock runs.
 *
 * It reads local state and never writes it back: nothing here applies a server
 * response to the source, because the whole point is that the cell the user is
 * typing in cannot be overwritten from the network.
 */
import { isRef, shallowReactive, watch } from 'vue'
import { createFlusher, type ResolvedWriter } from './flush'
import { isServer, onDispose, onTabHidden } from './lifecycle'
import { createOutbox } from './outbox'
import { createBackoff, createScheduler } from './scheduler'
import type {
  WriteBehind,
  WriteBehindKey,
  WriteBehindOptions,
  WriteBehindSource,
  WriteBehindWriter,
} from './types'

const DEFAULT_INTERVAL = 1000

/** The store as this module holds it: same shape, writable. */
type MutableWriteBehind<T> = { -readonly [K in keyof WriteBehind<T>]: WriteBehind<T>[K] }

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

  const outbox = createOutbox<T>({
    retryDelay: createBackoff(options.retry),
    onChange: () => onOutboxChange(),
  })
  const flusher = createFlusher<T>({ outbox, writer, now: Date.now })
  const scheduler = createScheduler({ interval, onTick: () => flusher.dispatch() })

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
    const dueAt = debounce > 0 ? Date.now() + debounce : 0
    for (const [key, value] of Object.entries(current)) {
      if (!tracked(key)) continue
      const seen = shadow.get(key)
      if (seen && equals(seen.value, value)) continue
      shadow.set(key, { value })
      outbox.set(key, value, dueAt)
    }
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
      outbox.set(key, value, debounce > 0 ? Date.now() + debounce : 0)
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
    const inFlight = outbox.inFlightKeys()
    store.pending = outbox.pendingKeys()
    store.inFlight = inFlight
    store.failed = outbox.failures()
    store.isSyncing = inFlight.length > 0
  }

  function onOutboxChange(): void {
    syncStore()
    // Never start a timer on the server, and never leave one running with
    // nothing to send — an idle app must not hold the event loop open.
    if (isServer()) return
    if (outbox.hasScheduledWork()) scheduler.start()
    else scheduler.stop()
  }

  watch(readSource, syncFromSource, { deep: true })

  const stopHiddenListener =
    options.flushOnHidden === false ? () => {} : onTabHidden(() => void store.flush())

  onDispose(() => {
    scheduler.stop()
    stopHiddenListener()
  })

  return store
}
