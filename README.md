# @ozjsey/vue-write-behind

**The write never comes back.** Local state stays authoritative and the network is a background
chore. Edit a cell ten times and one request goes out carrying the tenth value. The server's reply
is *discarded on purpose* — it can never overwrite the cell the user is still typing in. A failed
save rolls nothing back; the key stays dirty and goes out again next tick, carrying whatever has
been typed since.

It is a **state outbox, not an operation log**: keys are independent and last-write-wins.

See in action: [npm portfolio playground](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind) — and
[**the cell does not jump**](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/no-jump) is the whole claim in one card: type into a cell while a
slow server is answering, and watch the field not move.

The rest, each against a real (fake) server you can break from the card:
[coalescing](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/coalescing) ·
[failure never rolls back](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/failure-and-retry) ·
[`pending` / `inFlight` / `failed`](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/live-state) ·
[a batch endpoint](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/batch) ·
[`discard()`](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/discard) ·
[`interval` vs `debounce`](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/interval-and-debounce)

```bash
npm install @ozjsey/vue-write-behind
```

> **On 0.1.0? Upgrade to 0.1.1.** Calling `discard(key)` while that key's save was in flight let a
> second, concurrent request go out for it. If the two landed out of order the server was left
> holding the **older** value — with the newer one on screen, `pending` empty and no error anywhere.
> See [`CHANGELOG.md`](./CHANGELOG.md).

```vue
<script setup lang="ts">
import { reactive } from 'vue'
import { useWriteBehind } from '@ozjsey/vue-write-behind'

const cells = reactive<Record<string, string>>({ A1: 'foo' })
const outbox = useWriteBehind(cells, (value, key) => api.put(`/cell/${key}`, value))

cells.A1 = 'bar' // that is the whole API
</script>

<template>
  <input v-model="cells.A1" />
  <span v-if="outbox.isSyncing">saving…</span>
  <span v-else-if="outbox.pending.length">{{ outbox.pending.length }} unsaved</span>
</template>
```

No wrapper component, no query client, no schema. The record is yours; the composable watches it.

## What the defaults do

The bare form above is the configuration this library recommends — options exist to opt *out*.

| | Default | Why |
|---|---|---|
| Cadence | flush every **1000 ms**, and the timer only runs while something is queued | a burst of keystrokes is one request; an idle app holds no timer — [keystrokes vs requests, counted live](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/coalescing) |
| Coalescing | last-write-wins per key | the pending map is bounded by the number of keys, not edits |
| Parallelism | one request per due key, each in its own `try`/`catch` | keys are independent, so one slow key never holds up another, and one rejection never fails a sibling |
| The response | **ignored** — there is no opt-in | applying it is the "cell jumps while you type" bug |
| Failure | retry forever, per-key backoff 1 → 2 → 4 → 8 → 16 → 30 s (capped), timed to the millisecond rather than rounded up to the next tick, always re-sending the **current** value | silently dropping a user's edit is the one unacceptable outcome |
| Batch size | unlimited | |
| Leaving the page | flush on `visibilitychange → hidden` | best-effort — see below |
| Lifetime | stops on scope dispose, never starts on the server | |

## The store it returns

Reactive and already assembled — read it straight in a template.

| | |
|---|---|
| `pending` | every key with an unsaved change, in-flight ones included. The "you have unsaved work" number |
| `inFlight` | the subset whose own write is currently on the wire (a key waiting behind a *discarded* write's request is not in it) |
| `failed` | `{ key, error, attempts, retryAt }` per failing key — latest error only. `retryAt` is never in the past, and is `undefined` only when no automatic attempt is scheduled (`retry: false`) |
| `isSyncing` | `true` while anything is in flight |
| `set(key, value)` | write local state **and** queue it, unconditionally |
| `flush()` | send every pending key now — ignoring the debounce, the backoff and `retry: false`'s parked state. The one thing it cannot send is a key already on the wire. Resolving is not proof of success: read `pending` / `failed` afterwards |
| `retry(key?)` | clear the backoff and the recorded failure for one key, or all |
| `discard(key)` | drop a pending write. **The only operation here that loses one.** A request already on the wire cannot be recalled — the key is held back until it answers |

## Options

Every one is an opt-out. Pass them instead of the bare writer:

```ts
const outbox = useWriteBehind(cells, {
  write: (value, key) => api.put(`/cell/${key}`, value),
  interval: 1000,
  debounce: 0,
  retry: { initialDelay: 1000, maxDelay: 30000, factor: 2 }, // or `false`
  flushOnHidden: true,
  keys: ['A1', 'A2'],          // or (key) => key.startsWith('draft:')
  equals: (a, b) => a === b,
})
```

- **`interval`** — flush cadence in ms. It is a fixed window, not a debounce: it never restarts
  under a fast typist. It does not quantise the other clocks — a `debounce` or a retry backoff that
  falls between two ticks is woken for on its own deadline — and the timer only runs while a key is
  actually eligible.
- **`debounce`** — per-key quiet period before a key becomes eligible. Off by default because the
  interval already coalesces a burst. It is your clock: only an edit moves it, and a response
  landing mid-typing, a failure, or `retry()` cannot cut it short. It is tracked separately from the
  retry backoff, so neither shortens the other and a key waits for whichever is later.
- **`retry: false`** — stop retrying after a failure. The key is **not** dropped: it stays in
  `pending`, stays listed in `failed` with `retryAt: undefined`, and goes out again on the next
  edit, on `retry(key)`, or on `flush()` — including the automatic flush when the tab is hidden.
- **`keys`** — narrows what the source watcher picks up. `set()` is explicit and ignores it.
- **`equals`** — change detection, `Object.is` by default. See the precondition below.

### A batch endpoint

> [Batch writer vs per-key `allSettled`](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/batch) runs the same three edits through both writer
> shapes side by side, so the partial-failure rule below is something you can watch rather than
> take on trust.

The other shape worth first-class support. One call per tick, every due key in it:

```ts
useWriteBehind(cells, {
  flush: (entries) => api.patch('/cells', Object.fromEntries(entries)),
})
```

Throw or reject and the **whole batch** stays pending. Resolve with `{ failed: ['A1'] }` to fail
part of it — everything else in the batch is treated as written. The version guard is applied per
key inside the batch, exactly as it is per request.

## The rules that matter

**A key edited while its own write is in flight.** This is the case a boolean dirty flag gets
wrong: the response clears a flag a newer edit set, and that edit is gone — silently, with a
correct-looking value still on screen. Here each key carries a monotonic version, a write records
the version it was sent at, and a success clears the key **only if** the version has not moved.
Otherwise the key stays dirty and the newer value goes out next tick.

**A retry sends the current value, not the one that failed.** The value is read out of the map at
send time, never captured when the edit happened. So a save that failed at 09:00 and retries at
09:01 carries what is on screen at 09:01.

**One request per key at a time.** A key already in flight is skipped even when it is dirty, so two
requests for one cell can never race and land out of order. What is on the wire is recorded
separately from what is queued, so this survives `discard(key)` too: discarding a key whose request
is already out drops the queued write, but the key stays reserved until that request answers.
Nothing — not an edit, not `flush()`, not `retry()` — can open a second one. (Before 0.1.1 it could,
and the out-of-order landing left the server holding the *older* value with the screen showing the
newer one. See `CHANGELOG.md`.)

**Failure never rolls back.** Not local state, not the queue. `discard(key)` is the only way to
lose a write, and you have to call it. Two cards for this pair:
[type with the server down](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/failure-and-retry), and
[three near misses that still do not lose a write](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/discard).

## Preconditions — read these, they are not assumptions

- **Keys must be independent.** Writes go out in parallel, in no particular order, last-write-wins
  per key. If key `b` is only valid once key `a` has landed, this is the wrong tool.
- **`equals` defaults to `Object.is`, so an object value mutated *in place* is not an edit.**
  Replace the object (`cells.A1 = { ...cells.A1, text }`), pass your own `equals`, or call
  `outbox.set('A1', value)` — which always queues. All four outcomes side by side:
  [`equals`, and why in-place mutation is not an edit](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/equals-and-set).
- **The flush on tab-hidden is best-effort.** `visibilitychange → hidden` is used rather than
  `beforeunload`, which mobile browsers routinely skip — but the page can still be frozen before
  the request leaves. `pending` is exposed so your app can *warn* instead of failing silently.
- **A key deleted from the source keeps its queued write.** Losing it silently is exactly what this
  library refuses to do. Call `discard(key)` if you mean it.
- **Outside an effect scope there is no cleanup.** Called in `setup()` (or any `effectScope`) the
  timer and the listener are released on dispose. Called at module top level, they are not.
- **A server-side render queues but never sends, and its queue does not reach the client.** The
  outbox is a closure inside that render's effect scope; hydration builds a new composable with a
  new one, and nothing serialises it. Edits made during SSR are not handed over — put them in your
  own payload if you need them.
- **`discard(key)` cannot recall a request that has already left.** It drops the queued write and
  ignores the response, but the key stays reserved until that request answers, so a write queued in
  the meantime can never overtake it. Expect a key to sit in `pending` — and *not* in `inFlight` —
  for as long as the abandoned request takes.

## What it will not do

Each of these is a step towards RxDB / Replicache / TanStack DB, where a single small package loses
on day one:

- **No persistence / IndexedDB.** Hook `pending` yourself:
  ```ts
  watch(() => outbox.pending, (keys) => {
    localStorage.setItem('drafts', JSON.stringify(Object.fromEntries(keys.map((k) => [k, cells[k]]))))
  })
  ```
  `pending`, `inFlight` and `failed` keep their identity while their contents do not change, so a
  watcher like this fires when the set of unsaved keys actually moves — not on every retry of an
  outage.
- **No offline detection.** Offline is not a special case, it is a failing flush — the retry
  behaviour already covers it.
- **No conflict resolution or merge.** That needs a CRDT.
- **No reading.** It is write-only; nothing here fetches, caches or invalidates.
- **No ordered operation log and no cross-key transactions.**
- **No HTTP client, transport or `sendBeacon`.** You pass a function; what it does is your business.
- **No schema and no collections.**

## Types

Everything is exported by name — nothing to recreate:

```ts
import type {
  WriteBehind,
  WriteBehindBaseOptions,
  WriteBehindBatchOutcome,
  WriteBehindBatchWriter,
  WriteBehindFailure,
  WriteBehindKey,
  WriteBehindOptions,
  WriteBehindRetryOptions,
  WriteBehindSource,
  WriteBehindWriter,
} from '@ozjsey/vue-write-behind'
```

`T` is inferred from the record, so `useWriteBehind(reactive<Record<string, number>>({}), write)`
gives you a `write` whose value is a `number`.

## Development

```bash
npm test               # vitest: the state machine, the clock, the adapters, the composable
                       # (jsdom on Vue 3.5 and 3.3, plus an SSR project in node)
npm run typecheck      # tsc over source and tests
npm run build          # tsup → dist/*.min.js + .cjs + .d.ts
npm run check:dist     # drive the BUILT artifact on real timers — dist goes stale silently
npm run check:browser  # headless Chrome: type into a real input while a slow server answers,
                       # and read the value back out of the live DOM
```

`playground.html` is that browser check's page — serve the package directory and open it to try the
three cards by hand (`npm run check:browser` builds, serves and drives it for you). The claim it
exists to prove is the one no unit test can make: **the cell does not jump.**

`ARCHITECTURE.md` has the module map, the invariant the split protects, and the three pieces of
per-key state that are deliberately kept apart. `CHANGELOG.md` is the version history — read
0.1.1 before staying on 0.1.0.

## License

MIT © Ozgur Seyidoglu
