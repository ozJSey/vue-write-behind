/**
 * The two things only Vue can answer: is this a server render, and when does
 * this composable's owner go away.
 *
 * Everything else with a lifetime — the flush clock, the `visibilitychange`
 * listener — belongs to the engine and lives in `@ozjsey/write-behind`.
 */
import { getCurrentScope, onScopeDispose } from 'vue'

/**
 * True when there is no DOM — an SSR render, or a worker.
 *
 * The engine itself does **not** make this call: Node is a first-class target
 * there, and a script batching writes to a database wants its interval. What
 * makes a server *render* different is that the render has to finish and its
 * outbox is then thrown away, which only this layer knows — so this is the
 * layer that passes `autoFlush: false`.
 */
export const isServer = (): boolean =>
  typeof window === 'undefined' || typeof document === 'undefined'

/**
 * Register cleanup with the surrounding effect scope, if there is one. Called
 * outside `setup()` (imperative code, tests) there is nothing to hook, and Vue
 * would warn — so guard rather than warn.
 *
 * **These two imports set the package's Vue floor: `^3.2.0`.** `effectScope`
 * and with it `getCurrentScope` / `onScopeDispose` landed in Vue 3.2.0; 3.1.5
 * exports neither — not from the Node entry, not from the `@vue/reactivity`
 * esm-bundler entry a Vite or webpack build resolves. Below the floor this file
 * does not survive the import: Node ESM refuses to link it (`Named export
 * 'getCurrentScope' not found`), and where the binding resolves to `undefined`
 * instead, the call below is `TypeError: getCurrentScope is not a function`.
 *
 * Passing `onScopeDispose`'s `failSilently` argument instead of guarding would
 * be tidier, but it only arrived in 3.5 — three minors of floor for one line.
 */
export function onDispose(cleanup: () => void): void {
  if (getCurrentScope()) onScopeDispose(cleanup)
}
