import { defineWorkspace } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * Vitest projects:
 *
 *   - `vue-3.5` / `vue-3.3` — the same jsdom suites run against two Vue minor
 *     versions (the default `^3.5.0` and the aliased `vue3_3@3.3.13`) to prove
 *     the composable stays inside the supported peer range (`vue: ^3.0.0`).
 *     `watch(..., { deep: true })`, `shallowReactive` and `onScopeDispose` all
 *     predate 3.5, and nothing here may quietly start depending on 3.5-only
 *     behaviour.
 *
 *   - `ssr-node` — runs the SSR suite in `environment: 'node'` (no jsdom, no
 *     `window`, no `document`) to prove the package imports cleanly on the
 *     server and starts no timer there.
 */
const jsdomSuites = [
  'outbox.test.ts',
  'scheduler.test.ts',
  'flush.test.ts',
  'useWriteBehind.test.ts',
]

export default defineWorkspace([
  {
    test: {
      name: 'vue-3.5',
      environment: 'jsdom',
      include: jsdomSuites,
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
      include: jsdomSuites,
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
