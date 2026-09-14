import { defineWorkspace } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * Vitest projects:
 *
 *   - `vue-3.5` / `vue-3.3` — the same two jsdom suites run against two Vue
 *     minor versions (the default `^3.5.0` and the aliased `vue3_3@3.3.13`) to
 *     prove the composable stays inside the supported peer range
 *     (`vue: ^3.0.0`). `watch(..., { deep: true })`, `shallowReactive` and
 *     `onScopeDispose` all predate 3.5, and nothing here may quietly start
 *     depending on 3.5-only behaviour.
 *
 *     `keepAlive.test.ts` is the only suite that mounts real components, with
 *     `createApp` against a container — `<KeepAlive>` cannot be expressed
 *     through `effectScope()` at all. Running it on both versions is the point:
 *     `EffectScope.pause()` is 3.5-only, so "deactivation changes nothing here"
 *     has to be checked on each of them rather than assumed from one.
 *
 *   - `ssr-node` — runs the SSR suite in `environment: 'node'` (no jsdom, no
 *     `window`, no `document`) to prove the package imports cleanly on the
 *     server and starts no timer there.
 *
 * The engine's own suites live in `../write-behind` — the state machine, the
 * clock, the writer adapters and the shadow diff are not Vue's to re-prove.
 */

/**
 * The engine is resolved from `node_modules`, like any consumer resolves it.
 *
 * This used to alias `@ozjsey/write-behind` to the sibling working tree at
 * `../write-behind/writeBehind.ts`, to avoid reading a sibling's stale `dist/`
 * — a trap this portfolio has fallen into three times. That reasoning held
 * while the engine was unpublished and the two moved in lockstep.
 *
 * It does not hold now. The engine is a published dependency pinned by version
 * and integrity hash, so there is no sibling build to go stale — and the alias
 * had become actively harmful in two ways. It made these suites prove something
 * about the working tree rather than about the package consumers install; and
 * it resolved a path that exists only in this one workspace, so the suites
 * could not run anywhere else. CI checks out this repo alone and every suite
 * failed with "Failed to resolve import '@ozjsey/write-behind'", while the same
 * suites passed locally — the sibling was simply sitting there.
 */

export default defineWorkspace([
  {
    test: {
      name: 'vue-3.5',
      environment: 'jsdom',
      include: ['useWriteBehind.test.ts', 'keepAlive.test.ts'],
    },
  },
  {
    resolve: {
      alias: {
        vue: fileURLToPath(new URL('./node_modules/vue3_3/dist/vue.esm-bundler.js', import.meta.url)),
      },
    },
    test: {
      name: 'vue-3.3',
      environment: 'jsdom',
      include: ['useWriteBehind.test.ts', 'keepAlive.test.ts'],
    },
  },
  {
    test: {
      name: 'ssr-node',
      environment: 'node',
      include: ['vueWriteBehind.ssr.test.ts'],
    },
  },
])
