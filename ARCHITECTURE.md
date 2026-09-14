# Architecture

`vueWriteBehind.ts` is the build entry; it re-exports `src/index.ts`. Each module has one purpose;
dependencies point strictly downward — no cycles.

```
vueWriteBehind.ts              entry — re-exports src/index
└── src/
    ├── index.ts               public surface: useWriteBehind + the types
    ├── useWriteBehind.ts      the Vue surface — source watcher, reactive store, when the clock runs
    ├── lifecycle.ts           isServer, visibilitychange, onScopeDispose
    ├── flush.ts               THE request site — per-key and batched writer adapters
    ├── scheduler.ts           the clock — flush interval, deadline wake-ups, the backoff curve
    ├── outbox.ts              THE state machine — keys, versions, dirtiness, flights, deadlines
    └── types.ts               public types (leaf: one erased `import type` from vue, nothing else)
```

## The invariant

**Nothing outside `outbox.ts` may clear a dirty key.**

Every other module can only *ask*. `flush.ts` reports an outcome (`settle` / `fail`) and the outbox
decides what that means; `useWriteBehind.ts` reads snapshots into a reactive store; `scheduler.ts`
does not know keys exist. There is exactly one place where `entries.delete(key)` happens, and it is
guarded by the version check.

That guard is the whole product:

```ts
if (entry.version === sentVersion) entries.delete(key)   // nothing was typed while it was out
else { /* keep it dirty; send the newer value next tick */ }
```

A boolean dirty flag cannot express this. The response would clear a flag a newer edit had set, and
that edit would be gone — silently, with the correct-looking value still on screen. Every naive
write-behind implementation ships this bug, and it is invisible until a request is slow.

Two more properties fall out of keeping the decision in one place, and a third has to be built:

- **The value is read out of the map at send time** (`take()`), never captured when the edit
  happened. A retry therefore carries what the user has typed *since* the failure, not the value
  that failed. (`useMutation`-style retries re-send captured variables and can mark a cell saved
  with a stale value — this is the structural difference.) `useWriteBehind.ts` keeps a separate
  `shadow` map of the last value it *saw* per key, but that only decides whether an edit happened;
  it is never the value that is sent.
- **A key already in flight is skipped**, even when it is dirty, so two requests for one cell can
  never race and land out of order. This one does *not* fall out of the version guard, and pretending
  it did is what shipped the 0.1.0 data-loss bug: `discard(key)` deleted the entry, the entry was the
  only record that a request was in the air, and the next edit opened a second concurrent request.
  It is now enforced by a second map — see below.
- **Failure never clears anything.** The only operation in the library that loses a write is
  `discard(key)`, and a consumer has to call it.

## Three facts, three homes

Inside `outbox.ts`, a key's state is deliberately *not* one record. The 0.1.0 bug was a single
mutable `Entry` owning several independent facts, where every operation felt entitled to overwrite
all of them at once.

| Fact | Where it lives | Who may write it |
|---|---|---|
| what is queued for this key | `entries: Map<key, Entry>` | `set`, `settle`, `discard` |
| what is on the wire for it | `flights: Map<key, Flight>` | `take` (adds), `settle`/`fail` (remove), `discard` (disowns) |
| when it may next go | `entry.readyAt` (your `debounce`) and `entry.backoffUntil` (our retry curve), separately | `set` writes the first; `fail`/`settle`/`clearBackoff` write the second |

Two consequences, both of them bugs before 0.1.1:

- **`discard()` cannot forget a request.** It deletes the entry and marks the flight *disowned* —
  the outcome is ignored, but the key stays reserved until it answers, so nothing can race it. A
  request that has left cannot be recalled, and the library refuses to pretend otherwise.
- **A response cannot cancel your debounce.** `settle` and `fail` write `backoffUntil`; only an edit
  writes `readyAt`. When both are set the key waits for the later one.

A `Flight` also carries the version it was sent with, which is what makes a response identify
itself: a reply whose version is not the one currently on the wire for that key is ignored outright.

## Why the split is shaped this way

`outbox.ts` has no Vue, no timers and no I/O — every clock reading arrives as an argument, including
the one `failures(now)` needs to publish a `retryAt` that is never in the past. That is what makes
the correctness core testable as pure data (`outbox.test.ts`, no mounting, no fake timers) and
mutation-testable in seconds. The Vue layer, the clock and the transport are each thin enough to
read in one sitting once that core is trusted.

`useWriteBehind.ts` owns the library's single `Date.now()` call site and hands the reading down; it
is the only module that reads a clock rather than being given one, and `scheduler.ts` is the only
one that owns timers (the interval, plus a one-shot wake-up for a deadline that falls between two
ticks — without which a `retry.initialDelay` shorter than `interval` would be rounded away).

The bundle is unchanged by the split: tsup follows the single entry and tree-shakes. Verify with
`npm run build && npm pack --dry-run`, and `npm run check:dist` to prove the built artifact still
behaves (this repo has shipped a stale `dist/` three times).

Copy-paste consumers: every file under `src/` plus the entry is self-contained TypeScript with no
dependency beyond the `vue` peer — take the folder as-is, or lift `outbox.ts` on its own if all you
want is the state machine. The modules import each other without file extensions (`./outbox`), which
is what `moduleResolution: bundler` (this repo's `tsconfig.json`, and Vite/webpack/tsup projects)
expects; under `NodeNext` or plain Node ESM add the `.js` suffix to those five specifiers.
