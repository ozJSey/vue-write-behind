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
 * Resolve the engine from its **source**, not from `node_modules/…/dist`.
 * `dist/` in this portfolio has gone stale silently three times, and a test run
 * reading a sibling's last build instead of its working tree is the same trap
 * one package further out. `npm run check:dist` is where the built artifact
 * gets its turn.
 */
const writeBehind = {
  '@ozjsey/write-behind': fileURLToPath(new URL('../write-behind/writeBehind.ts', import.meta.url)),
}

export default defineWorkspace([
  {
    resolve: { alias: writeBehind },
    test: {
      name: 'vue-3.5',
      environment: 'jsdom',
      include: ['useWriteBehind.test.ts', 'keepAlive.test.ts'],
    },
  },
  {
    resolve: {
      alias: {
        ...writeBehind,
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
    resolve: { alias: writeBehind },
    test: {
      name: 'ssr-node',
      environment: 'node',
      include: ['vueWriteBehind.ssr.test.ts'],
    },
  },
])
