/**
 * The consumer's view: import the BUILT artifact (not `src/`) and drive real
 * cycles on real timers.
 *
 * `dist/` in this repo has gone stale silently three times, and every unit
 * suite here imports source — so this is the only thing that fails when the
 * tarball and the source disagree. Run it with `npm run check:dist`.
 *
 * Four passes, because the correct behaviour differs by environment:
 *   1. bare Node (no `window`, no `document`) — the SSR guard must keep the
 *      timer from ever starting;
 *   2. with the two globals the client path looks for — the full cycle;
 *   2b. the flush on page-hide, fired for real through a dispatching fake DOM:
 *      `pagehide` sends, the writer is told it is `final`, and a
 *      `visibilitychange` behind it does not send a second request;
 *   3. the 0.1.0 data-loss regression: discard a key while its request is out,
 *      type again, and check what the SERVER ends up holding.
 *
 * Every wait is a poll with a deadline, never a bare sleep sized to beat an
 * interval — the same box runs CI.
 */
import { effectScope, nextTick, reactive } from 'vue'
import { useWriteBehind } from './dist/vueWriteBehind.min.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
const check = (what, ok, detail = '') => results.push([what, ok, detail])

/** Poll until `predicate` holds. Returns false on timeout instead of throwing. */
const waitUntil = async (predicate, timeout = 5000, step = 5) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(step)
  }
  return predicate()
}

// ---------------------------------------------------------------- pass 1: SSR
{
  const cells = reactive({ A1: 'from-server' })
  const calls = []
  const scope = effectScope()
  const outbox = scope.run(() =>
    useWriteBehind(cells, { write: (value) => calls.push(value), interval: 20 }),
  )

  cells.A1 = 'edited-server-side'
  await nextTick()
  await sleep(150)

  check('server-side: no request is made', calls.length === 0)
  // NOT a hand-off: this queue is a closure in this render's effect scope, and
  // hydration builds a new one. It is here to prove the edit was not dropped
  // on the floor by the SSR guard, nothing more.
  check('server-side: the edit is queued, not dropped', outbox.pending.length === 1)
  scope.stop()
}

// ------------------------------------------------------------- pass 2: client
// The minimum DOM the client path looks for: `isServer()` checks both globals,
// and the flush on page-hide subscribes to `visibilitychange` on `document`
// **and** to `pagehide`/`pageshow` on `window`. A fake that only answers the
// first would hide a half-wired listener, so this one dispatches for real.
const fakeTarget = (extra = {}) => {
  const bag = new Map()
  return {
    ...extra,
    addEventListener: (type, fn) => bag.set(type, [...(bag.get(type) ?? []), fn]),
    removeEventListener: (type, fn) =>
      bag.set(type, (bag.get(type) ?? []).filter((listener) => listener !== fn)),
    dispatch: (type) => {
      for (const fn of bag.get(type) ?? []) fn()
    },
  }
}
globalThis.window = fakeTarget()
globalThis.document = fakeTarget({ visibilityState: 'visible' })

{
  const cells = reactive({ A1: 'from-server' })
  const calls = []
  const scope = effectScope()
  const outbox = scope.run(() =>
    useWriteBehind(cells, {
      write: (value, key) => {
        calls.push([key, value])
        return sleep(60)
      },
      interval: 50,
    }),
  )

  cells.A1 = 'a'
  cells.A1 = 'b'
  await nextTick()
  await waitUntil(() => outbox.inFlight.length === 1)
  const inFlightDuringWrite = [...outbox.inFlight]

  cells.A1 = 'typed-while-in-flight'
  await waitUntil(() => outbox.pending.length === 0)

  console.log('requests sent :', JSON.stringify(calls))
  console.log('local value   :', cells.A1)

  check('two edits in one window went out as one request', calls.length === 2, `${calls.length} calls`)
  check('the request carried the newest value in its window', calls[0]?.[1] === 'b')
  check('the key was in flight while the request was out', inFlightDuringWrite.length === 1)
  check('the edit made during the flight went out next', calls[1]?.[1] === 'typed-while-in-flight')
  check('the response never touched local state', cells.A1 === 'typed-while-in-flight')
  check('everything settled', outbox.pending.length === 0 && outbox.failed.length === 0)
  scope.stop()
}

// ------------------------------------------ pass 2b: the flush on page-hide
// The engine's listeners, reached through the composable — this package adds
// none of its own, so the only thing that can break here is the delegation.
{
  const cells = reactive({ A1: 'v0' })
  const sent = []
  const scope = effectScope()
  const outbox = scope.run(() =>
    useWriteBehind(cells, {
      write: (value, key, attempt) => sent.push({ value, key, attempt }),
      interval: 30000, // nothing leaves on the clock during this pass
    }),
  )

  cells.A1 = 'typed-just-before-the-refresh'
  await nextTick()
  check('nothing went out on the clock', sent.length === 0)

  globalThis.window.dispatch('pagehide')
  await waitUntil(() => sent.length > 0)

  check('pagehide flushed it', sent[0]?.value === 'typed-just-before-the-refresh', JSON.stringify(sent))
  check(
    'and the writer was told the page is going away',
    sent[0]?.attempt?.reason === 'unload' && sent[0]?.attempt?.final === true,
    JSON.stringify(sent[0]?.attempt),
  )

  // Both events for one teardown is the common desktop case; it must not send
  // a second request.
  globalThis.document.visibilityState = 'hidden'
  globalThis.document.dispatch('visibilitychange')
  await sleep(50)
  check('visibilitychange after it does not send a second', sent.length === 1, `${sent.length} sent`)

  check('nothing is left pending', outbox.pending.length === 0)
  scope.stop()
  globalThis.document.visibilityState = 'visible'
}

// ------------------------------------------- pass 3: discard() cannot lose a write
// 0.1.0: discard() deleted the only record that a request was in the air, so
// the next edit opened a second, concurrent one. The fast second landed first,
// the slow first landed last, and the server kept the OLDER value — with
// `pending: []` on screen saying everything was saved.
{
  const cells = reactive({ A1: 'v0' })
  const applied = []
  let inAir = 0
  let maxInAir = 0
  let latency = 400 // the first request is slow, the rest are fast
  const scope = effectScope()
  const outbox = scope.run(() =>
    useWriteBehind(cells, {
      write: async (value) => {
        inAir += 1
        maxInAir = Math.max(maxInAir, inAir)
        const takes = latency
        latency = 20
        await sleep(takes)
        applied.push(value)
        inAir -= 1
      },
      interval: 50,
    }),
  )

  cells.A1 = 'v1-slow'
  await nextTick()
  await waitUntil(() => outbox.inFlight.length === 1)

  outbox.discard('A1')
  cells.A1 = 'v2-fast'
  await waitUntil(() => outbox.pending.length === 0 && inAir === 0)

  console.log('server applied:', JSON.stringify(applied))

  check('never two requests in the air for one key', maxInAir === 1, `max ${maxInAir}`)
  check(
    'the server ends up holding the newest value',
    applied[applied.length - 1] === 'v2-fast',
    JSON.stringify(applied),
  )
  check('local state is what the user typed', cells.A1 === 'v2-fast')
  scope.stop()
}

for (const [what, ok, detail] of results) {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${detail ? `  — ${detail}` : ''}`)
}
const failed = results.filter(([, ok]) => !ok).length
console.log(failed === 0 ? '\nDIST CHECK: PASS' : `\nDIST CHECK: ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
