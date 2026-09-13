/**
 * The consumer's view: import the BUILT artifact (not `src/`) and drive one
 * real cycle on real timers.
 *
 * `dist/` in this repo has gone stale silently three times, and every unit
 * suite here imports source — so this is the only thing that fails when the
 * tarball and the source disagree. Run it with `npm run check:dist`.
 *
 * Two passes, because the correct behaviour differs by environment:
 *   1. bare Node (no `window`, no `document`) — the SSR guard must keep the
 *      timer from ever starting, while the edit still queues;
 *   2. with the two globals the client path looks for — the full cycle.
 */
import { effectScope, nextTick, reactive } from 'vue'
import { useWriteBehind } from './dist/vueWriteBehind.min.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
const check = (what, ok) => results.push([what, ok])

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
  await sleep(100)

  check('server-side: no request is made', calls.length === 0)
  check('server-side: the edit is still queued for the client', outbox.pending.length === 1)
  scope.stop()
}

// ------------------------------------------------------------- pass 2: client
// The minimum DOM the client path looks for: `isServer()` checks both globals,
// and the tab-hidden flush subscribes to `document`.
globalThis.window = globalThis
globalThis.document = {
  visibilityState: 'visible',
  addEventListener: () => {},
  removeEventListener: () => {},
}

{
  const cells = reactive({ A1: 'from-server' })
  const calls = []
  const scope = effectScope()
  const outbox = scope.run(() =>
    useWriteBehind(cells, {
      write: (value, key) => {
        calls.push([key, value])
        return sleep(30)
      },
      interval: 20,
    }),
  )

  cells.A1 = 'a'
  cells.A1 = 'b'
  await nextTick()
  await sleep(30)
  const inFlightDuringWrite = [...outbox.inFlight]

  cells.A1 = 'typed-while-in-flight'
  await sleep(150)

  console.log('requests sent :', JSON.stringify(calls))
  console.log('local value   :', cells.A1)

  check('ten edits, one window, one request', calls.length === 2)
  check('the request carried the newest value in its window', calls[0]?.[1] === 'b')
  check('the key was in flight while the request was out', inFlightDuringWrite.length === 1)
  check('the edit made during the flight went out next', calls[1]?.[1] === 'typed-while-in-flight')
  check('the response never touched local state', cells.A1 === 'typed-while-in-flight')
  check('everything settled', outbox.pending.length === 0 && outbox.failed.length === 0)
  scope.stop()
}

for (const [what, ok] of results) console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}`)
const failed = results.filter(([, ok]) => !ok).length
console.log(failed === 0 ? '\nDIST CHECK: PASS' : `\nDIST CHECK: ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
