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
    ├── scheduler.ts           the clock — flush interval + the backoff curve
    ├── outbox.ts              THE state machine — keys, versions, dirtiness, backoff state
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

Three properties fall out of keeping the decision in one place:

- **The value is read out of the map at send time** (`take()`), never captured when the edit
  happened. A retry therefore carries what the user has typed *since* the failure, not the value
  that failed. (`useMutation`-style retries re-send captured variables and can mark a cell saved
  with a stale value — this is the structural difference.)
- **A key already in flight is skipped**, even when it is dirty, so two requests for one cell can
  never race and land out of order.
- **Failure never clears anything.** The only operation in the library that loses a write is
  `discard(key)`, and a consumer has to call it.

## Why the split is shaped this way

`outbox.ts` has no Vue, no timers and no I/O — every clock reading arrives as an argument. That is
what makes the correctness core testable as pure data (`outbox.test.ts`, no mounting, no fake
timers) and mutation-testable in seconds. The Vue layer, the clock and the transport are each thin
enough to read in one sitting once that core is trusted.

The bundle is unchanged by the split: tsup follows the single entry and tree-shakes. Verify with
`npm run build && npm pack --dry-run`, and `npm run check:dist` to prove the built artifact still
behaves (this repo has shipped a stale `dist/` three times).

Copy-paste consumers: every file under `src/` plus the entry is self-contained TypeScript with no
dependency beyond the `vue` peer — take the folder as-is, or lift `outbox.ts` on its own if all you
want is the state machine.
