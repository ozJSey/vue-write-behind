# Architecture

**This package is an adapter, not an implementation.** Since 0.2.0 the state machine, the clock and
the writer adapters live in [`@ozjsey/write-behind`](https://www.npmjs.com/package/@ozjsey/write-behind)
— a zero-dependency, framework-free package — and this one is the ~40 lines that make it Vue.

`vueWriteBehind.ts` is the build entry; it re-exports `src/index.ts`. Each module has one purpose;
dependencies point strictly downward — no cycles.

```
vueWriteBehind.ts              entry — re-exports src/index
└── src/
    ├── index.ts               public surface: useWriteBehind + the types
    ├── useWriteBehind.ts      the adapter — source watcher, reactive store, the SSR decision
    ├── lifecycle.ts           the two things only Vue can answer: isServer, onScopeDispose
    └── types.ts               the two Vue-shaped types; the rest are re-exported from the engine

@ozjsey/write-behind           the engine — outbox, scheduler, flush, shadow, snapshot, visibility
                               (the flush on visibilitychange/pagehide is its listener, not ours)
```

The engine is a real `dependencies` entry and the build treats it as **external**: `dist/` carries
`import { createWriteBehind } from '@ozjsey/write-behind'` and not one line of the state machine, so
installing both packages never ships two copies of it. Read that package's `ARCHITECTURE.md` for the
invariant — *nothing outside `outbox.ts` may clear a dirty key* — and for the version guard that is
the whole product.

## What this layer actually decides

Three things, and they are the only three Vue answers that the engine cannot:

- **The record announces itself.** The engine has no observer — a plain object cannot say it
  changed, which is exactly what keeps it framework-free — so it exposes `sync()`. Here that is
  `watch(readSource, core.sync, { deep: true })`. One line, and it is the entire conceptual
  difference between the two packages.

- **The state is readable in a template.** The engine publishes `pending` / `inFlight` / `failed` /
  `isSyncing` as snapshot getters whose identity is stable while their contents are, and calls
  `subscribe` after every transition. This layer mirrors all four into one `shallowReactive` store
  on every notification, assigning unconditionally — because assigning an unchanged reference to a
  `shallowReactive` triggers nothing. That is what keeps `watch(() => outbox.pending, …)` (the
  README's persistence recipe) quiet through a retry storm, and it is pinned by a test.

- **It stops when its owner does.** `onScopeDispose(core.dispose)` — guarded by `getCurrentScope()`,
  because called outside `setup()` there is nothing to hook and Vue would warn.

Plus one decision that looks like a fourth: **a server render gets no clock.** The engine deliberately
does *not* check for a DOM before starting its timer (Node is a first-class target there, and a
script batching writes to a database wants its interval). What makes a server *render* different is
that the render has to finish and its outbox is discarded afterwards — and only this layer knows it
is a render. So `isServer()` lives here, and it is passed down as `autoFlush: false`.

## What this layer does not get to re-decide

`store.flush()` reads the source before dispatching. That is not a courtesy: the source watcher is
a `pre` watcher, so an edit made in the current tick has not been seen yet, and a save button next
to an input would otherwise miss the last keystroke. It falls out for free — `core.flush()` is
defined as `sync()` then dispatch — and there is a test here that would fail if it stopped being
true.

Everything else that looks like policy is the engine's: what counts as an edit (`equals`), which
keys are watched (`keys`), when a key is eligible (`interval`, `debounce`, the backoff curve),
whether a response may clear a key (the version guard), and whether two requests for one key can
exist (they cannot). This package neither implements nor overrides any of it, and the test suite
here is deliberately end-to-end rather than a second copy of `outbox.test.ts`.

**The page going away is on that list.** `visibilitychange → hidden`, `pagehide`, their
de-duplication and the `final` flag that lets a writer set `keepalive` are all the engine's, and
this package adds no unload handling of its own — there is one implementation to maintain. What it
does owe is proof that the delegation works, which is what the `pagehide` and `reason: 'unload'`
cases in `useWriteBehind.test.ts` are for.

## `<KeepAlive>`, measured

A deactivated component is cached, not disposed — a third state between "alive" and "gone" — and it
is worth naming what happens there, because the intuitive answer is wrong. Vue 3.5 added
`EffectScope.pause()`, but `KeepAlive` does not use it: deactivating only sets
`instance.isDeactivated`. So **nothing is paused**. The deep source watcher still runs, an edit made
while the component is off screen is queued at once, the engine's clock sends it, and the flush on
page-hide reaches it too. Only a real unmount stops any of it, and that is `onScopeDispose`.

`keepAlive.test.ts` is the only suite here that mounts real components (`createApp` against a
container — `@vue/test-utils` is deliberately not a dependency), because `effectScope()` cannot
express deactivation at all. It runs on both Vue versions, which is the point: `pause()` is 3.5-only,
so "deactivation changes nothing" has to be checked on each rather than assumed from one.

## Testing

`useWriteBehind.test.ts` (56 declarations) and `keepAlive.test.ts` (9) both run in jsdom against Vue
3.5 **and** Vue 3.3 — the `vue: ^3.0.0` peer range is a claim, and `watch(..., { deep: true })`,
`shallowReactive` and `onScopeDispose` all predate 3.5. `vueWriteBehind.ssr.test.ts` (3) runs in
`environment: 'node'` to prove the package imports with no top-level DOM access and starts **no
timer** on the server.

Both projects alias `@ozjsey/write-behind` to the sibling's **source**, never its `dist/` — a test
run reading a sibling's last build instead of its working tree is the stale-dist trap one package
further out. The engine's own suites (the state machine, the clock, the writer adapters, the diff)
live in that package; re-proving them here would be a second copy that could drift.

`npm run check:dist` is where the built artifacts get their turn: it rebuilds the engine, rebuilds
this package, and drives the tarball's entry on real timers — through the real
`node_modules/@ozjsey/write-behind` resolution, so it also proves the dependency wiring. `npm run
check:browser` does the same in headless Chrome against `playground.html`, which is the only check
that can make the claim no unit test can: **the cell does not jump.**

## Copy-paste consumers

The four files under `src/` are not self-contained any more — lifting them alone gets you an adapter
with nothing to adapt. **Lift `@ozjsey/write-behind`'s `src/` instead**: it is the whole engine, has
no dependency of any kind, and its `outbox.ts` can be taken on its own if all you want is the state
machine. Then add these four on top, or write the ~40 lines of `useWriteBehind.ts` yourself — the
file is short on purpose, and its three responsibilities are listed above.

The modules import each other without file extensions (`./types`), which is what
`moduleResolution: bundler` (this repo's `tsconfig.json`, and Vite/webpack/tsup projects) expects;
under `NodeNext` or plain Node ESM add the `.js` suffix.

## Local development before the engine is published

`@ozjsey/write-behind` is declared as `^0.1.0` and, until it is on the registry, is not installable.
`npm run link:core` symlinks the sibling checkout into `node_modules/@ozjsey/` exactly as `npm link`
would and rebuilds it; `check:dist` and `check:browser` run it first, because those two are the
checks that resolve the engine by bare specifier through Node rather than through a bundler alias.
Once it is published, an ordinary `npm install` replaces that script entirely.
