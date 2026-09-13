/**
 * The writer adapters — the only place a request is made.
 *
 * Two shapes, one rule: whatever the network does, the outcome is reported back
 * to the outbox and nothing else. This module never clears a key itself, never
 * looks at what a writer resolved with, and never touches local state. The
 * server's reply is discarded on purpose.
 *
 * Per-key writes are independent, so they run in parallel and each key settles
 * the moment its own request returns (`Promise.allSettled` semantics — one
 * rejection can neither block nor fail a sibling). That is safe only because
 * key independence is a stated precondition of the library.
 */
import type { Outbox, OutboxEntry } from './outbox'
import type {
  WriteBehindBatchOutcome,
  WriteBehindBatchWriter,
  WriteBehindKey,
  WriteBehindWriter,
} from './types'

/** Exactly one writer, already narrowed from the options. */
export type ResolvedWriter<T> =
  | { write: WriteBehindWriter<T>; flush?: undefined }
  | { write?: undefined; flush: WriteBehindBatchWriter<T> }

export interface FlusherConfig<T> {
  outbox: Outbox<T>
  writer: ResolvedWriter<T>
  /** Injected so the flusher owns no clock of its own. */
  now: () => number
}

export interface Flusher {
  /** Send everything due. `force` ignores the debounce and backoff clocks. */
  dispatch: (force?: boolean) => void
  /** Force a dispatch and wait for every request currently in the air. */
  flush: () => Promise<void>
}

const failedKeysOf = (outcome: WriteBehindBatchOutcome | void): readonly WriteBehindKey[] => {
  if (!outcome) return []
  return outcome.failed ?? []
}

export function createFlusher<T>({ outbox, writer, now }: FlusherConfig<T>): Flusher {
  const inAir = new Set<Promise<void>>()

  const track = (flight: Promise<void>): void => {
    inAir.add(flight)
    void flight.then(() => inAir.delete(flight))
  }

  const runPerKey = async (write: WriteBehindWriter<T>, entry: OutboxEntry<T>): Promise<void> => {
    try {
      await write(entry.value, entry.key)
      outbox.settle(entry.key, entry.sentVersion)
    } catch (error) {
      outbox.fail(entry.key, entry.sentVersion, error, now())
    }
  }

  const runBatch = async (
    flushAll: WriteBehindBatchWriter<T>,
    batch: OutboxEntry<T>[],
  ): Promise<void> => {
    const entries = batch.map((entry): [WriteBehindKey, T] => [entry.key, entry.value])
    try {
      const failed = new Set(failedKeysOf(await flushAll(entries)))
      for (const entry of batch) {
        if (failed.has(entry.key)) {
          outbox.fail(
            entry.key,
            entry.sentVersion,
            new Error(`vue-write-behind: batch flush reported "${entry.key}" as failed`),
            now(),
          )
        } else {
          outbox.settle(entry.key, entry.sentVersion)
        }
      }
    } catch (error) {
      // One rejection means the transport failed, so nothing in the batch is
      // known to have landed — every key stays pending.
      for (const entry of batch) outbox.fail(entry.key, entry.sentVersion, error, now())
    }
  }

  const dispatch = (force = false): void => {
    const batch = outbox.take(force ? Number.POSITIVE_INFINITY : now())
    if (batch.length === 0) return
    // The union guarantees exactly one of the two is present.
    if (writer.flush) track(runBatch(writer.flush, batch))
    else for (const entry of batch) track(runPerKey(writer.write, entry))
  }

  return {
    dispatch,
    flush: async () => {
      dispatch(true)
      await Promise.all([...inAir])
    },
  }
}
