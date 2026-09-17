# Changelog

All notable changes to `@ozjsey/vue-write-behind`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-09-17

Supersedes `0.1.1` (published 2026-09-14T10:03:16Z). Release state is verified against
`registry.npmjs.org` by `node scripts/changelog-audit.mjs`, never against this file.

**Mostly re-plumbing. `useWriteBehind`'s surface did not move: same signature, same returned store,
same type names, same behaviour** — every one of the 54 existing test declarations still passes
across Vue 3.5, Vue 3.3 and the node/SSR project with **no assertion changed**, and the browser
check passes unchanged. (Four writer helpers *inside* those tests grew the new third parameter so
they could forward it; nothing they assert moved.)

The one addition on top of that is the page-refresh work below. It widens the writer signature
additively — an existing writer is unaffected — and is inherited from the engine rather than
implemented here.

### Changed

- **The engine moved to [`@ozjsey/write-behind`](https://www.npmjs.com/package/@ozjsey/write-behind),
  and this package now consumes it.** Owner request: *"Write behind doesn't really need to be Vue,
  make a typescript version of it as well, and most ideally vue package uses the package."* One
  state machine, two packages, no fork.

  `src/outbox.ts`, `src/scheduler.ts` and `src/flush.ts` contained no Vue, no timers coupled to Vue
  and no I/O, and moved verbatim with their suites (81 declarations). Everything else that was not
  Vue — the shadow map and its diff, the `keys` filter, `equals`, the clock, the scheduling
  decision, the snapshot comparators — moved out of `useWriteBehind.ts` too. What is left here is
  the three things only Vue can answer: `watch(source, sync, { deep: true })`, mirroring the
  engine's snapshots into a `shallowReactive` store, and `onScopeDispose`.

  It is a real `dependencies` entry and the build treats it as **external**, so installing both
  packages never ships two copies of the state machine. The ESM artifact is 728 B, down from 5 KB.

- **The batch writer's synthetic error message** is now
  `write-behind: batch flush reported "<key>" as failed`, previously prefixed `vue-write-behind:`.
  It is the only user-visible string that moved; nothing in this repo or its tests ever matched on
  it.

### Added

- **A write can now survive a page refresh**, and every bit of it is inherited from the engine —
  this package gained **no** unload handling of its own, because there is one implementation to
  maintain:

  - **`pagehide` is flushed on, as well as `visibilitychange → hidden`**, de-duplicated so a browser
    firing both sends one request. 0.1.1 listened only to `visibilitychange`, so an iOS Safari
    swipe-away — which fires `pagehide` and nothing else — flushed **nothing**. Measured on 0.1.1,
    on both supported Vue versions.
  - **Your writer is told when the page is going away.** A third argument to `write` and a second to
    `flush`, both additive — a two-argument writer keeps compiling and keeps working:

    ```ts
    useWriteBehind(cells, (value, key, { final }) =>
      fetch(`/cell/${key}`, { method: 'PUT', body: JSON.stringify(value), keepalive: final }),
    )
    ```

    `{ reason: 'scheduled' | 'manual' | 'unload', final, attempt }`. The library owns no transport —
    the writer is yours, by design — so it cannot set `keepalive` for you; what it can do is say
    when it matters.
  - **`outbox.flush('unload')`** says the same thing by hand, for a router leave guard or any other
    signal the engine refuses to listen to on your behalf.

  The README's new *surviving a page refresh* section carries the constraints that bite silently:
  the 64 KiB budget shared by every in-flight keepalive request in the page, `sendBeacon` being
  POST-only and sharing it, why the batch writer is the better unload path, and that there is no
  retry after `final`.

- **`autoFlush`** (default `true`) — do not run the flush clock at all; edits still queue, `pending`
  still reports them, and `flush()` still sends them. It is the option this layer already sets for
  you during a server render, now also available on the client for an app that wants to own its
  cadence.

### Fixed

- **Disposing while a save was in flight could leave the clock running forever.** `onScopeDispose`
  stopped the scheduler, but nothing stopped a *later* outbox transition from restarting it: a
  response landing after disposal, with a newer edit queued behind it, found the key still dirty,
  called `reschedule()` and started a brand new interval on a dead composable — which then kept
  writing. Disposal is now a one-way flag in the engine, and re-arming happens behind it. Pinned by
  `createWriteBehind.test.ts` → "cannot be undone by a response landing after it".

  *Exposure:* a component unmounted mid-save with an edit queued behind the in-flight one — closing
  a modal or navigating away while typing. The requests it kept making were correct and carried the
  right values; the leak is the timer and the unstoppable writes, not lost data.

### Documented — `<KeepAlive>`, and what it does not do

A deactivated component had never been exercised: `useWriteBehind.test.ts` drives everything through
`effectScope()` and never mounts anything, so `<KeepAlive>` was untested and undocumented. It now
has a suite that mounts real components (`keepAlive.test.ts`, `createApp` against a container —
`@vue/test-utils` stays out of the devDependencies), run on Vue 3.5 **and** 3.3.

The finding is that **deactivation changes nothing**. Vue 3.5 added `EffectScope.pause()`, but
`KeepAlive` does not use it — deactivating only sets `instance.isDeactivated`. So the deep source
watcher still runs, an edit made while the component is off screen is queued at once, the clock
sends it, and the flush on page-hide reaches it too. Only a real unmount stops any of it, and that
is `onScopeDispose`. No behaviour changed here; what changed is that it is now pinned and stated.

### Fixed — in the checks, not the library

- **`dist-check.mjs`'s fake DOM only stubbed `document`.** `pagehide`/`pageshow` are window events,
  so the check started throwing on a `window` that was `globalThis` with no `addEventListener` —
  correctly, because it was not a faithful fake. It now builds a small dispatching target for each
  global and fires `pagehide` for real, which turns it into the only check that proves the unload
  flush works through the **built** artifacts and the real package resolution.

### Notes

- **`npm install` needs `@ozjsey/write-behind` to be on the registry.** Until it is, `npm run
  link:core` symlinks the sibling checkout and rebuilds it; the unit suites resolve the engine from
  its source through a vitest alias and need nothing.

[0.2.0]: https://github.com/ozJSey/vue-write-behind/releases/tag/v0.2.0

## [0.1.1] — 2026-09-14

**Upgrade from 0.1.0. It could lose a write silently, with nothing on screen to say so.**

### Fixed

- **`discard()` on a key whose request was already in the air let a second, concurrent request
  go out for that key — and if the two landed out of order the server was left holding the
  OLDER value.** `discard(key)` deleted the outbox entry, and that entry was the library's only
  record that a request existed: `entry.sentVersion`. With it gone, the next edit created a fresh
  entry and the next tick sent it, so two writes for one key were on the wire at once. Driven end
  to end with a slow first request and a fast second: the cell showed `v2`, `pending` reported
  `[]` ("all saved"), and the server had applied `v2` then `v1` — permanently stale, no error, no
  failed entry, nothing in the client to trace it back to `discard`.

  This is the exact case `README.md` and `ARCHITECTURE.md` both stated as an absolute guarantee
  ("two requests for one cell can never race and land out of order"). **The guarantee is now
  true.** What is on the wire is recorded in its own map, keyed by key and carrying the version
  it was sent with, and only a response removes it. `discard()` deletes the queued write and
  marks that flight disowned — its outcome is ignored, and it does not record a failure against
  whatever is queued next — but the key stays reserved until the request answers. Nothing can
  open a second one: not an edit, not `flush()`, not `retry()`. While a key waits behind a
  discarded write's request it is in `pending` and, deliberately, not in `inFlight`.

  *Exposure:* any app calling `discard()` on a key that could have a save in flight — the
  "undo"/"revert this cell" button next to an autosaving field. Nothing else in 0.1.0 could
  produce two flights for one key.

- **A response landing while you typed cancelled your `debounce`.** One field, `dueAt`, held
  three things: the debounce deadline, the retry backoff, and `0` meaning "eligible now". `set`
  was careful with it; nothing else was. A superseded success set `dueAt = 0` ("the server is
  healthy, drop the backoff") and dropped the *quiet period* instead; a failure overwrote a
  debounce longer than the backoff; `retry()` zeroed it for keys that were merely being typed
  into. Measured with `debounce: 2000`: a keystroke at t=2303ms went out at t=3041ms — 738ms
  later, not 2000. The two clocks are now separate fields and a key waits for whichever is
  later; only an edit moves the debounce.

- **`retryAt` published the internal sentinel.** `failed[].retryAt` was `dueAt` handed out raw,
  so a key re-armed after a `retry: false` failure reported `0` — `new Date(0)` renders
  "Jan 1, 1970" — and a key whose retry was already on the wire reported a past timestamp, so a
  "retrying in Ns" countdown ran negative. It is now never in the past (a due-now key reports
  the current time) and is `undefined` only when no automatic attempt is scheduled at all.

- **`flush()` could not send a key parked by `retry: false`, and resolved as if it had.** The
  forced dispatch defeated the clocks but not the blocked flag, so `flush()` was inert for
  exactly the keys most at risk of being lost — including the automatic flush when the tab is
  hidden, which is the library's own last-chance save. `flush()` now ignores the parked state
  too. It still cannot send a key whose request is already on the wire, and resolving is still
  not proof of success: read `pending` / `failed` afterwards.

- **`retry.initialDelay` did nothing whenever `interval` was longer than it.** The only thing
  that called the outbox was a fixed `setInterval`, so every backoff was rounded up to the next
  tick of that grid: with `interval: 500, initialDelay: 100, factor: 2` the measured gaps were
  503/502/502 instead of 100/200/400, and `interval: 30000` ("save every 30s") flattened the
  documented 1→2→4→8→16→30s curve to 30s throughout. The scheduler now also wakes once for the
  next deadline, so debounce and backoff are honoured to the millisecond. As a side effect the
  interval no longer spins through no-op ticks while every key is backed off.

- **The reactive store rebuilt `pending`, `inFlight` and `failed` on every outbox transition**,
  changing their identity even when their contents had not, so a `watch` on `pending` — the
  README's own persistence recipe — re-fired on every retry of an outage. And because a source
  sweep queued one key at a time, an N-key change cost N full rebuilds. Measured against both
  built artifacts on the same machine: the persistence recipe performed **23 synchronous
  `localStorage` writes in 600ms** of a sustained outage (11 attempts) while `pending` never
  changed from `["A1"]`, and pasting 8000 cells blocked the main thread for **1188ms**. The
  arrays are now diffed before assignment and a source sweep is one notification: the same
  outage writes **once**, and the same paste takes **21ms** (2000 cells: 89ms → 14ms, 4000:
  247ms → 16ms).

### Changed

- `discard()` on an in-flight key no longer makes the key immediately available. This is the
  fix, not a side effect: a request that has left cannot be recalled, and the alternative is the
  data loss above. Expect such a key to sit in `pending` (and not in `inFlight`) until the
  abandoned request answers.
- The tab-hidden flush and `flush()` now send keys parked by `retry: false`.
- Retries and debounced writes fire on their own deadline rather than on the next `interval`
  tick, so both are up to one interval earlier than in 0.1.0. Cadence for ordinary edits is
  unchanged: a burst still coalesces into one request per `interval`.

### Documentation

- `README.md` "One request per key at a time" and `ARCHITECTURE.md`'s matching bullet said this
  was a property that *fell out* of the version guard. It never did, and saying so is what let
  the hole survive review. Both now name what enforces it, and `ARCHITECTURE.md` has a "Three
  facts, three homes" section: what is queued, what is on the wire, and when the key may next
  go are three separate pieces of state with three separate writers.
- The README claimed `Promise.allSettled` over the due keys; the source contained no such call.
  Per-key isolation comes from a `try`/`catch` per request (`flush()` now does use
  `allSettled` to await them).
- Documented that an SSR render's queue does not reach the client — the SSR test and the dist
  check both described a hand-off that cannot exist, since the outbox is a closure in that
  render's effect scope and nothing serialises it.
- `retryAt`, `flush()`, `retry()`, `discard()`, `inFlight` and `debounce` all had doc comments
  that no longer matched the code; each was corrected rather than left as an aspiration.

### Verified

- 267 tests across three vitest projects (jsdom on Vue 3.5 and 3.3, plus a no-DOM node project
  for SSR). The data-loss bug is pinned end to end by a test that asserts what the **server**
  ends up holding, not what the library believes: a 3000ms first request, a 50ms second, and the
  assertion `serverValue === 'v2-fast'` (0.1.0 leaves `'v1-slow'`).
- The suite was mutation-tested: **58 of 59 targeted mutations killed.** The set covers flight
  identity (delete the flight on discard, let `force` override a flight, drop the in-flight
  guard), the two clocks (each deadline ignored, each cancelled by the wrong writer), what is
  published (`retryAt` raw, blocked keys given a timestamp), the scheduler (no wake-up, stacked
  wake-ups, uncapped backoff) and the store diffing. The single survivor is provably equivalent:
  the ownership check in `settle` cannot be observed, because a key held by a disowned flight
  can never have been re-sent, so the entry it would have touched is always in its default
  state. `fail`'s identical check *is* observable and is killed.
- `npm run check:dist` drives the built artifact on real timers and now includes the
  discard-mid-flight regression, asserting the order the fake server applied the writes in. Run
  against a clean build of 0.1.0 it fails with `server applied: ["v2-fast","v1-slow"]` and
  `max 2` requests in the air — the published defect, reproduced against the published tarball's
  code.
- `npm run check:browser` drives `playground.html` in headless Chrome with real key events. Its
  headline assertion no longer relies on the fixture happening to uppercase its replies: every
  value the input is ever seen holding must be a prefix of the exact string the script typed,
  and the sequence may never go backwards. It also reads the request log back and asserts no two
  requests for one key were ever in the air at once — including across a `discard()` mid-flight,
  which is the browser-level proof of the fix. Run against a clean build of 0.1.0 that assertion
  fails, with the log showing `PUT … | PUT … | 200 … | 200 …`. Both scripts poll with deadlines
  instead of sleeping against the intervals they are measuring.

### Known limitations

- There is still no tab in the cross-package playground and no `instructions/vue-write-behind.md`
  brief; `playground.html` is a CDP fixture rather than a copy-pasteable example. Tracked in
  `tickets/WBC-3-playground-and-docs.md` and `tickets/WBC-5-brief-and-backlog-entry.md`.

## [0.1.0] — 2026-09-13

First release, published to npm as `@ozjsey/vue-write-behind`.

### Added

- `useWriteBehind(source, writer | options)` — a write-behind cache for a `reactive()` record (or
  a `ref()` holding one). Local state stays authoritative and the writer's result is discarded on
  purpose, so a slow reply can never overwrite the cell the user is typing in.
- Per-key monotonic versions: a success clears a key only if its version has not moved since the
  request left, so an edit made mid-flight is never marked saved.
- Per-key writer (`write`) or batched writer (`flush`), the latter able to fail part of a batch
  with `{ failed: [...] }`.
- Options `interval`, `debounce`, `retry` (or `false`), `flushOnHidden`, `keys`, `equals` — every
  one an opt-*out*.
- A reactive store: `pending`, `inFlight`, `failed`, `isSyncing`, plus `set`, `flush`, `retry`
  and `discard`.
- Retry forever by default with a capped exponential backoff; failure never rolls back local
  state and never drops the queued write.
- Flush on `visibilitychange → hidden`, no timer on the server, cleanup on scope dispose.
