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
 * would warn — so guard rather than warn. `getCurrentScope()` exists in 3.0;
 * `onScopeDispose`'s `failSilently` argument only arrived in 3.5.
 */
export function onDispose(cleanup: () => void): void {
  if (getCurrentScope()) onScopeDispose(cleanup)
}
