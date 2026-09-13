/**
 * Everything with a lifetime outside the outbox: the environment check, the
 * tab-hidden hook and scope disposal.
 *
 * `visibilitychange` rather than `beforeunload`: mobile browsers routinely
 * discard a page without ever firing `beforeunload`, and Safari fires
 * `pagehide` instead. `visibilitychange → hidden` is the one signal that fires
 * on every platform — and it is still only best-effort, because the page can be
 * frozen before the request leaves. `pending` is exposed so an app can warn.
 */
import { getCurrentScope, onScopeDispose } from 'vue'

/** True when there is no DOM — SSR, or a worker. */
export const isServer = (): boolean =>
  typeof window === 'undefined' || typeof document === 'undefined'

/** Subscribe to the tab going hidden. Returns the unsubscribe; a no-op on the server. */
export function onTabHidden(handler: () => void): () => void {
  if (isServer()) return () => {}
  const listener = (): void => {
    if (document.visibilityState === 'hidden') handler()
  }
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}

/**
 * Register cleanup with the surrounding effect scope, if there is one. Called
 * outside `setup()` (imperative code, tests) there is nothing to hook, and Vue
 * would warn — so guard rather than warn. `getCurrentScope()` exists in 3.0;
 * `onScopeDispose`'s `failSilently` argument only arrived in 3.5.
 */
export function onDispose(cleanup: () => void): void {
  if (getCurrentScope()) onScopeDispose(cleanup)
}
