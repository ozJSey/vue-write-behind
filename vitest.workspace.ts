import { defineWorkspace } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * Vitest projects:
 *
 *   - `vue-3.2` — **the declared floor, `vue: ^3.2.0`, run for real.** The
 *     alias is pinned to exactly `3.2.0`, the lowest version that range admits,
 *     so this project is what makes the peer range a checked claim rather than
 *     a hope. It fails the moment anything here reaches for an API newer than
 *     3.2: pointed one minor lower, at 3.1.5, all 65 declarations fail with
 *     `TypeError: getCurrentScope is not a function` from `src/lifecycle.ts`,
 *     which is the import that sets the floor in the first place.
 *
 *     This project replaces a claim that could not fail. The comment here used
 *     to say the 3.3/3.5 pair proved "the composable stays inside the supported
 *     peer range (`vue: ^3.0.0`)" — the range was wrong by two minors, and the
 *     matrix could not have caught it, because its lowest version was 3.3.13,
 *     well above the first Vue that has `getCurrentScope`.
 *
 *   - `vue-3.5` / `vue-3.3` — the same two jsdom suites at the top of the range
 *     (the default `^3.5.0`) and in the middle of it (`vue3_3@3.3.13`), so a
 *     regression that only shows up between the floor and today is still seen.
 *
 *     `keepAlive.test.ts` is the only suite that mounts real components, with
 *     `createApp` against a container — `<KeepAlive>` cannot be expressed
 *     through `effectScope()` at all. Running it on every version is the point:
 *     `EffectScope.pause()` is 3.5-only, so "deactivation changes nothing here"
 *     has to be checked on each of them rather than assumed from one.
 *
 *   - `ssr-node` — runs the SSR suite in `environment: 'node'` (no jsdom, no
 *     `window`, no `document`) to prove the package imports cleanly on the
 *     server and starts no timer there.
 *
 * What none of these can prove is that the *published tarball* installs against
 * the floor — they run source against an aliased Vue. That is `npm pack` plus a
 * real install, which the release checklist owns.
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

const JSDOM_SUITES = ['useWriteBehind.test.ts', 'keepAlive.test.ts']

/** The aliased Vue for a floor/mid project — a pinned copy under its own name. */
const vueAlias = (pkg: string) => ({
  vue: fileURLToPath(new URL(`./node_modules/${pkg}/dist/vue.esm-bundler.js`, import.meta.url)),
})

export default defineWorkspace([
  {
    resolve: { alias: vueAlias('vue3_2') },
    test: {
      name: 'vue-3.2',
      environment: 'jsdom',
      include: JSDOM_SUITES,
    },
  },
  {
    resolve: { alias: vueAlias('vue3_3') },
    test: {
      name: 'vue-3.3',
      environment: 'jsdom',
      include: JSDOM_SUITES,
    },
  },
  {
    test: {
      name: 'vue-3.5',
      environment: 'jsdom',
      include: JSDOM_SUITES,
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
