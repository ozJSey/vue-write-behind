/**
 * `<KeepAlive>` — the one lifecycle state a composable can meet that is neither
 * "alive" nor "gone": the component is cached, invisible, and its `setup()` will
 * never run again.
 *
 * This is the only suite here that **mounts real components**.
 * `useWriteBehind.test.ts` drives everything through `effectScope()`, which is
 * the right tool for the composable's own behaviour but cannot express
 * deactivation at all — so until this file existed, `<KeepAlive>` had never been
 * exercised. `@vue/test-utils` is deliberately not a dependency; `createApp`
 * against a real container is enough and keeps the devDependency list honest.
 *
 * What it pins, measured identically on Vue 3.2.0 (the declared floor), 3.3.13
 * and 3.5.42:
 *
 *   - **deactivation does not pause anything.** Vue 3.5 added
 *     `EffectScope.pause()`, but `KeepAlive` does not use it — deactivating only
 *     sets `instance.isDeactivated`. The deep source watcher still runs, so an
 *     edit made while the component is cached is queued at once and goes out on
 *     the clock like any other.
 *   - **the unload flush reaches it too**, on either signal.
 *   - **a real unmount still stops everything** — that is `onScopeDispose`, and
 *     it is the only thing that does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, KeepAlive, nextTick, reactive, ref, type App } from 'vue'
import { useWriteBehind } from './src/useWriteBehind'
import type { WriteBehind } from './src/types'

const apps: App[] = []

/** Let Vue's scheduler run, then the flush clock, then everything it started. */
async function tick(ms = 0): Promise<void> {
  await nextTick()
  await vi.advanceTimersByTimeAsync(ms)
  await nextTick()
}

/**
 * A `<KeepAlive>` around one component that owns an outbox, mounted for real.
 * `shown` toggles between the cached child and a placeholder — which
 * *deactivates* the child rather than unmounting it, and is the whole point.
 */
function harness() {
  const writes: string[] = []
  const cells = reactive<Record<string, string>>({ A1: 'seed' })
  const shown = ref(true)
  let captured: WriteBehind<string> | undefined

  const Child = defineComponent({
    name: 'Cell',
    setup() {
      const outbox = useWriteBehind(cells, (value, key) => {
        writes.push(`${key}=${value}`)
        return Promise.resolve()
      })
      captured = outbox
      return () => h('div', outbox.pending.join(','))
    },
  })

  const Wrapper = defineComponent({
    name: 'Wrapper',
    setup: () => () =>
      h(KeepAlive, null, { default: () => (shown.value ? h(Child) : h('p', 'away')) }),
  })

  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp(Wrapper)
  apps.push(app)
  app.mount(el)

  const outbox = (): WriteBehind<string> => {
    if (!captured) throw new Error('the child never ran setup()')
    return captured
  }
  return { writes, cells, shown, outbox }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})

afterEach(() => {
  for (const app of apps.splice(0)) app.unmount()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('mounted for real', () => {
  it('saves an edit like any other component', async () => {
    const app = harness()
    await tick()

    app.cells.A1 = 'typed'
    await tick(1000)

    expect(app.writes).toEqual(['A1=typed'])
  })
})

describe('<KeepAlive> — while the component is deactivated', () => {
  /** Swap the cached child out for the placeholder: deactivated, not unmounted. */
  const deactivate = async (app: ReturnType<typeof harness>): Promise<void> => {
    app.shown.value = false
    await tick()
  }

  it('still queues an edit — the watcher is not paused', async () => {
    const app = harness()
    await tick()
    await deactivate(app)

    app.cells.A1 = 'while-deactivated'
    await nextTick()

    expect(app.outbox().pending).toEqual(['A1'])
  })

  it('still sends it, on the same clock', async () => {
    const app = harness()
    await tick()
    await deactivate(app)

    app.cells.A1 = 'while-deactivated'
    await tick(1000)

    expect(app.writes).toEqual(['A1=while-deactivated'])
    expect(app.outbox().pending).toEqual([])
  })

  it('is flushed by the tab going hidden', async () => {
    const app = harness()
    await tick()
    await deactivate(app)

    app.cells.A1 = 'rescued'
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await tick()

    expect(app.writes).toEqual(['A1=rescued'])
  })

  it('is flushed by pagehide — the refresh case, on a cached component', async () => {
    const app = harness()
    await tick()
    await deactivate(app)

    app.cells.A1 = 'rescued'
    window.dispatchEvent(new Event('pagehide'))
    await tick()

    expect(app.writes).toEqual(['A1=rescued'])
  })

  it('keeps working after it comes back', async () => {
    const app = harness()
    await tick()
    await deactivate(app)

    app.shown.value = true
    await tick()
    app.cells.A1 = 'after-reactivate'
    await tick(1000)

    expect(app.writes).toEqual(['A1=after-reactivate'])
  })
})

describe('<KeepAlive> — a real unmount', () => {
  it('stops the clock: an edit afterwards goes nowhere', async () => {
    const app = harness()
    await tick()
    for (const mountedApp of apps.splice(0)) mountedApp.unmount()

    app.cells.A1 = 'after-unmount'
    await tick(5000)

    expect(app.writes).toEqual([])
  })

  it('stops it from a deactivated state too', async () => {
    const app = harness()
    await tick()
    app.shown.value = false
    await tick()
    for (const mountedApp of apps.splice(0)) mountedApp.unmount()

    app.cells.A1 = 'after-unmount'
    await tick(5000)

    expect(app.writes).toEqual([])
  })

  it('drops the unload listeners with it', async () => {
    const app = harness()
    await tick()
    app.cells.A1 = 'never-sent'
    await nextTick()
    expect(app.outbox().pending).toEqual(['A1'])

    for (const mountedApp of apps.splice(0)) mountedApp.unmount()
    window.dispatchEvent(new Event('pagehide'))
    await tick()

    // Disposal loses nothing — the key is still queued, it just has nothing
    // left to send it. `flush()` on a disposed engine still would.
    expect(app.writes).toEqual([])
    expect(app.outbox().pending).toEqual(['A1'])
  })
})
