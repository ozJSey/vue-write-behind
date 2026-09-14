#!/usr/bin/env node
/**
 * Real-browser check — drives `playground.html` in headless Chrome and reads
 * every result back out of the live DOM.
 *
 * It exists for the one claim no unit test can make: **the cell does not jump
 * when a slow server responds while the user is still typing in it.** jsdom has
 * no real input, no real focus and no real event loop pressure, so the only
 * honest proof is a real keyboard against a real `<input>` while a real request
 * is in the air.
 *
 * The jump test is built from the exact keystrokes this script sent: every
 * value the input is ever seen holding must be a prefix of what was typed, and
 * the sequence must never go backwards. That holds whatever the fixture's
 * server answers with — it does not depend on the demo happening to uppercase.
 *
 * Every wait is a poll against the live DOM. A fixed sleep racing the page's
 * own 1000ms interval is how a check becomes a coin toss nobody trusts.
 *
 *   npm run check:browser
 *   CHROME_PATH=/path/to/chrome npm run check:browser
 *
 * The page imports `dist/`, so this checks the built artifact too. Run
 * `npm run build` first (`check:browser` does).
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Cdp, launchChrome, newPage, sleep } from './lib/cdp.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PORT = Number(process.env.PORT ?? 5311)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

const serve = () =>
  new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname))
      const file = join(ROOT, path === '/' ? 'playground.html' : path)
      if (!file.startsWith(ROOT)) {
        res.writeHead(403).end()
        return
      }
      try {
        const body = await readFile(file)
        res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
        res.end(body)
      } catch {
        res.writeHead(404).end(`not found: ${path}`)
      }
    })
    server.listen(PORT, () => resolve(server))
  })

const results = []
const check = (what, ok, detail = '') => {
  results.push({ what, ok, detail })
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}${detail ? `  — ${detail}` : ''}`)
}

/** Read the rendered text of a card element. */
const text = (page, testid) =>
  page.evaluate(
    `document.querySelector('[data-testid="${testid}"]')?.textContent.trim() ?? '<missing>'`,
  )

/** Read an input's live value straight off the DOM node. */
const inputValue = (page, testid) =>
  page.evaluate(`document.querySelector('[data-testid="${testid}"]').value`)

async function focus(page, testid) {
  await page.evaluate(`document.querySelector('[data-testid="${testid}"]').focus()`)
}

/** Type with real key events, one character at a time. */
async function type(cdp, page, string_, afterEach) {
  for (const character of string_) {
    await cdp.send(
      'Input.dispatchKeyEvent',
      { type: 'keyDown', text: character, unmodifiedText: character, key: character },
      page.sessionId,
    )
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: character }, page.sessionId)
    await sleep(40)
    if (afterEach) await afterEach()
  }
}

/** Poll until `predicate` holds, or give up after `timeout` ms. */
async function waitFor(predicate, timeout = 8000, step = 100) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(step)
  }
  return false
}

/**
 * The request log as an ordered list of events. `PUT` = a request left,
 * `200`/`207` = one answered.
 */
const requestTrace = (log) =>
  log
    .split('\n')
    .map((line) => (line.includes('PUT') ? 'out' : line.includes('200') ? 'back' : undefined))
    .filter(Boolean)

/**
 * H5, read straight off the page: a second request for a key may not leave
 * before the first has answered. This is what the 0.1.0 discard() bug broke —
 * two concurrent flights, landing out of order, server left holding the stale
 * value.
 */
const overlappingRequests = (trace) => {
  let inAir = 0
  let worst = 0
  for (const event of trace) {
    inAir += event === 'out' ? 1 : -1
    worst = Math.max(worst, inAir)
  }
  return worst
}

const server = await serve()
const { proc, wsUrl } = await launchChrome({ port: 9341 })
const cdp = await Cdp.connect(wsUrl)
const page = await newPage(cdp, `http://127.0.0.1:${PORT}/playground.html`)

try {
  check('the page mounted', await waitFor(async () => (await text(page, 'log')).length > 0))

  // ------------------------------------------------------ 1: the cell does not jump
  const TYPED = 'hello world'
  await focus(page, 'cell')
  await type(cdp, page, 'hel')

  // The page flushes on a 1000ms interval and the fake server takes 2s to
  // answer, so poll rather than guessing how long that takes here.
  check(
    'a request went out for what was typed',
    await waitFor(async () => (await text(page, 'log')).includes('"hel"')),
  )
  check(
    'the key is in flight',
    await waitFor(async () => (await text(page, 'inflight')).includes('A1')),
  )

  // Keep typing while that request is still in the air, sampling the live
  // input after every keystroke and until the response has landed, so a jump
  // has nowhere to hide.
  const observed = []
  const sample = async () => observed.push(await inputValue(page, 'cell'))
  await sample()
  await type(cdp, page, 'lo world', sample)
  const responded = await waitFor(async () => {
    await sample()
    return (await text(page, 'log')).includes('(discarded)')
  })
  check('the slow response actually came back (or this proves nothing)', responded)
  await sample()

  // Everything the input was ever seen holding must be something the user
  // typed: a prefix of TYPED, and never shorter than the sample before it.
  const foreign = observed.filter((value) => !TYPED.startsWith(value))
  const wentBackwards = observed.filter(
    (value, index) => index > 0 && value.length < observed[index - 1].length,
  )
  check(
    'the input only ever held what the user had typed',
    foreign.length === 0 && wentBackwards.length === 0,
    foreign.length || wentBackwards.length
      ? `foreign ${JSON.stringify(foreign)} / backwards ${JSON.stringify(wentBackwards)}`
      : `${new Set(observed).size} distinct values across ${observed.length} samples`,
  )
  check(
    'the input holds exactly what was typed',
    (await inputValue(page, 'cell')) === TYPED,
    JSON.stringify(await inputValue(page, 'cell')),
  )

  const settled = await waitFor(async () => (await text(page, 'pending')).includes('none'))
  check('nothing is left pending once the second response lands', settled)

  const log = await text(page, 'log')
  const puts = log.split('\n').filter((line) => line.includes('PUT'))
  check('the edit made during the flight went out afterwards', log.includes(`"${TYPED}"`))
  check(
    'eleven keystrokes went out as two requests',
    puts.length === 2,
    `${puts.length} PUTs for ${TYPED.length} keystrokes`,
  )
  check('the response was discarded', log.includes('(discarded)'))
  check(
    'no two requests for one key were ever in the air at once',
    overlappingRequests(requestTrace(log)) === 1,
    log.replace(/\n/g, ' | '),
  )

  // ------------------- 1b: discard() while a request is out (the 0.1.0 data-loss bug)
  // Type, wait for the request to leave, discard the queued write, then type
  // again. The request on the wire cannot be recalled, so the next one must
  // wait for it — in 0.1.0 a second request left immediately and the two could
  // land out of order, leaving the server holding the older value.
  await focus(page, 'cell')
  await type(cdp, page, '!')
  check(
    'a second edit went out',
    await waitFor(async () => (await text(page, 'inflight')).includes('A1')),
  )
  await page.evaluate(`document.querySelector('[data-testid="discard-a1"]').click()`)
  await type(cdp, page, '?')
  const drained = await waitFor(async () => (await text(page, 'pending')).includes('none'), 12000)
  check('the outbox drains after a discard mid-flight', drained)

  const afterDiscard = await text(page, 'log')
  check(
    'discarding an in-flight key did not open a second concurrent request',
    overlappingRequests(requestTrace(afterDiscard)) === 1,
    afterDiscard.replace(/\n/g, ' | '),
  )
  const lastPut = afterDiscard
    .split('\n')
    .filter((line) => line.includes('PUT'))
    .pop()
  check(
    'the last request the server saw carried the newest value',
    lastPut?.includes(`"${TYPED}!?"`) ?? false,
    lastPut ?? '<no PUT>',
  )
  check('the input still holds exactly what was typed', (await inputValue(page, 'cell')) === `${TYPED}!?`)

  // -------------------------------------------------------- 2: failure never rolls back
  const attemptCount = async () => Number((await text(page, 'attempts')).replace(/\D/g, ''))
  await focus(page, 'flaky-cell')
  await type(cdp, page, 'draft')

  check(
    'it retried on its own',
    await waitFor(async () => (await attemptCount()) >= 2),
    `${await attemptCount()} attempts`,
  )
  check('a failing key stays pending', (await text(page, 'flaky-pending')).includes('B2'))
  check('the failure is reported', (await text(page, 'failed')).includes('failed: 1'))
  check('local state was not rolled back', (await inputValue(page, 'flaky-cell')) === 'draft')

  await type(cdp, page, '-more')
  await page.evaluate(`document.querySelector('[data-testid="retry"]').click()`)
  check(
    'the retry carried the current value, not the one that failed',
    await waitFor(async () => (await text(page, 'flaky-log')).includes('"draft-more"')),
  )

  await page.evaluate(`document.querySelector('[data-testid="discard"]').click()`)
  check(
    'discard() is what drops it',
    await waitFor(async () => (await text(page, 'flaky-pending')).includes('none')),
  )

  // ---------------------------------------------------------------- 3: batch endpoint
  await focus(page, 'batch-c1')
  await type(cdp, page, 'one')
  await focus(page, 'batch-c3')
  await type(cdp, page, 'three')
  await waitFor(async () => (await text(page, 'batch-log')).includes('PATCH'))

  const batchLog = await text(page, 'batch-log')
  check('both keys went out in one PATCH', batchLog.includes('"C1":"one"') && batchLog.includes('"C3":"three"'))
  check('the batch reported a partial failure', (await text(page, 'batch-failed')).includes('C3'))
  check('only the failed key stayed pending', (await text(page, 'batch-pending')).includes('C3'))

  // --------------------------------------------------------------------------- errors
  check(
    'no console errors or uncaught exceptions',
    page.consoleErrors.length === 0 && page.pageErrors.length === 0,
    [...page.consoleErrors, ...page.pageErrors].join(' | '),
  )
} finally {
  cdp.close()
  proc.kill('SIGKILL')
  server.close()
}

const failed = results.filter((r) => !r.ok)
console.log(
  failed.length === 0
    ? `\nBROWSER CHECK: PASS (${results.length} checks)`
    : `\nBROWSER CHECK: ${failed.length}/${results.length} FAILED`,
)
process.exit(failed.length === 0 ? 0 : 1)
