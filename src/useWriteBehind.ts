/**
 * The Vue surface — a thin adapter over `@ozjsey/write-behind`.
 *
 * The engine there holds every rule this library is about: the version guard,
 * the one-request-per-key reservation, the retry curve, the shadow diff. None
 * of it is Vue-shaped, so none of it is here. What *is* here is the three
 * things Vue answers that a plain object cannot:
 *
 *   - **the record announces itself.** The engine has no observer, so it needs
 *     someone to call `sync()`. `watch(..., { deep: true })` is that someone.
 *   - **the state is readable in a template.** The engine publishes identity-
 *     stable snapshots; this mirrors them into one `shallowReactive` store.
 *   - **it stops when its owner does** — `onScopeDispose`, and no clock at all
 *     during a server render.
 *
 * It reads local state and never writes it back: nothing here applies a server
 * response to the source, because the whole point is that the cell the user is
 * typing in cannot be overwritten from the network.
 */
import { createWriteBehind } from '@ozjsey/write-behind'
import { isRef, shallowReactive, watch } from 'vue'
import { isServer, onDispose } from './lifecycle'
import type {
  WriteBehind,
  WriteBehindKey,
  WriteBehindOptions,
  WriteBehindSource,
  WriteBehindWriter,
} from './types'

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

  const readSource = (): Record<WriteBehindKey, T> => (isRef(source) ? source.value : source)

  const core = createWriteBehind<T>(readSource, {
    ...options,
    // A server render has to finish, and a live interval holds the response
    // open — while the queue it would flush is a closure in this render's scope
    // and is discarded at the end anyway. `flush()` still sends if you ask.
    autoFlush: !isServer() && options.autoFlush !== false,
  })

  const store = shallowReactive<MutableWriteBehind<T>>({
    pending: core.pending,
    inFlight: core.inFlight,
    failed: core.failed,
    isSyncing: core.isSyncing,
    set: core.set,
    flush: core.flush,
    retry: core.retry,
    discard: core.discard,
  })

  core.subscribe(() => {
    // Assigned unconditionally on purpose: the engine keeps each snapshot's
    // identity while its contents do not move, and `shallowReactive` does not
    // notify on a write that changes nothing. So a `watch(() => outbox.pending,
    // …)` — the README's persistence recipe — fires when the set of unsaved
    // keys actually moves, and stays quiet through a retry storm.
    store.pending = core.pending
    store.inFlight = core.inFlight
    store.failed = core.failed
    store.isSyncing = core.isSyncing
  })

  watch(readSource, core.sync, { deep: true })

  onDispose(core.dispose)

  return store
}
