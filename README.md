# @ozjsey/vue-write-behind

One composable over a reactive record: edit local state, and the writes go out on a clock.

[![npm](https://img.shields.io/npm/v/@ozjsey/vue-write-behind.svg)](https://www.npmjs.com/package/@ozjsey/vue-write-behind)
![license MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![gzipped 0.43 KiB](https://img.shields.io/badge/gzipped-0.43%20KiB-blue.svg)
![dependencies 1](https://img.shields.io/badge/dependencies-1-blue.svg)

> **[See it live](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind)** — eleven
> cards, every option and every state member, each against a real (fake) server you can break from
> the card.

## The problem

A key is edited while its own write is in flight. This is the case a boolean dirty flag gets wrong:
the response clears a flag a newer edit set, and that edit is gone — silently, with a
correct-looking value still on screen. It is invisible until a request is slow, and every autosave
hand-rolled out of `watch` + `debounce` + `isSaving` has it.

## The solution

Each key carries a monotonic version, a write records the version it was sent at, and a success
clears the key **only if** the version has not moved. **The write never comes back.** Local state
stays authoritative and the network is a background chore. Edit a cell ten times and one request
goes out carrying the tenth value. The server's reply is *discarded on purpose* — it can never
overwrite the cell the user is still typing in. A failed save rolls nothing back; the key stays
dirty and goes out again next tick, carrying whatever has been typed since.

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

It is a **state outbox, not an operation log**: keys are independent and last-write-wins. No
persistence, no offline detection, no conflict resolution and no reading — each of those is a step
towards RxDB / Replicache / TanStack DB, where a single small package loses on day one.

## Install

```bash
npm install @ozjsey/vue-write-behind
```

**Requires Vue `3.2.0` or newer.** `getCurrentScope` / `onScopeDispose` arrived with `effectScope`
in 3.2, and this package calls them to release the outbox when its owner goes away. Nothing here
needs anything newer — the floor itself is in the test matrix, pinned exactly.

There is nothing to register: it is a composable, not a plugin or a directive. The engine
underneath is [`@ozjsey/write-behind`](https://www.npmjs.com/package/@ozjsey/write-behind) — zero
dependencies, no framework — and it installs automatically.

## Usage

### Options are opt-*outs*

The bare form above is the configuration this library recommends. Pass an object instead of the
writer to change one:

```ts
const outbox = useWriteBehind(cells, {
  write: (value, key) => api.put(`/cell/${key}`, value),
  interval: 1000,   // flush cadence — a fixed window, not a debounce; it never restarts
  debounce: 0,      // per-key quiet period; off, because interval already coalesces a burst
  retry: { initialDelay: 1000, maxDelay: 30000, factor: 2 },   // or `false` to park a key
  keys: (key) => key.startsWith('draft:'),                     // or an allow-list
})
```

`retry: false` does **not** drop the key: it stays in `pending`, stays listed in `failed` with
`retryAt: undefined`, and goes out again on the next edit, on `retry(key)`, or on `flush()`.

### A batch endpoint

One call per tick, every due key in it:

```ts
useWriteBehind(cells, {
  flush: (entries) => api.patch('/cells', Object.fromEntries(entries)),
})
```

Throw or reject and the **whole batch** stays pending. Resolve with `{ failed: ['A1'] }` to fail
part of it — everything else in the batch is treated as written.

### Surviving a page refresh

```ts
useWriteBehind(cells, (value, key, { final }) =>
  fetch(`/cell/${key}`, {
    method: 'PUT',
    body: JSON.stringify(value),
    keepalive: final,        // the browser finishes this one after the page is gone
  }),
)
```

When the page goes away this composable flushes on `visibilitychange → hidden` **and** `pagehide`,
de-duplicated into one — `beforeunload` is deliberately not used, because mobile browsers routinely
discard a page without ever firing it. That flush is **forced**: it ignores the debounce clock, the
retry backoff and `retry: false`, so it carries the character typed 200 ms before the tab closed.
What it cannot do is make the request outlive the page. Only `keepalive` does that, and the request
is yours. `outbox.flush('unload')` says the same thing by hand, for a router leave guard.

## Everything else

Every option, every state member, driven against a fake server you can break from the card:
[**the cell does not jump**](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/no-jump)
is the whole claim in one — type into a cell while a slow server is answering, and watch the field
not move. Then
[coalescing](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/coalescing) ·
[failure never rolls back](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/failure-and-retry) ·
[`retry: false` parks a key](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/retry-false) ·
[`pending` / `inFlight` / `failed` / `isSyncing`](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/live-state) ·
[a batch endpoint](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/batch) ·
[`discard()` is the only way to lose a write](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/discard) ·
[`interval` vs `debounce`](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/interval-and-debounce) ·
[`keys`](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/keys-filter) ·
[`equals`, and why in-place mutation is not an edit](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/equals-and-set) ·
[`flush()`, and the flush when the page goes away](https://ozjsey.github.io/npm-portfolio-playground/#vue-write-behind/flush-and-tab-hide)

`ARCHITECTURE.md` has the module map and the three things this layer decides that the engine
cannot. [`CHANGELOG.md`](./CHANGELOG.md) is the version history.

## License

MIT © Ozgur Seyidoglu
