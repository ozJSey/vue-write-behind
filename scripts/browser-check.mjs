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
async function waitFor(predicate, timeout = 6000, step = 150) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(step)
  }
  return false
}

const server = await serve()
const { proc, wsUrl } = await launchChrome({ port: 9341 })
const cdp = await Cdp.connect(wsUrl)
const page = await newPage(cdp, `http://127.0.0.1:${PORT}/playground.html`)

try {
  await sleep(500)
  check('the page mounted', (await text(page, 'log')).length > 0)

  // ------------------------------------------------------ 1: the cell does not jump
  await focus(page, 'cell')
  await type(cdp, page, 'hel')

  // Let the first flush go out (interval 1000ms) — the server takes 2s to answer.
  await sleep(1300)
  check('a request went out for what was typed', (await text(page, 'log')).includes('"hel"'))
  check('the key is in flight', (await text(page, 'inflight')).includes('A1'))

  // Keep typing while that request is still in the air, sampling the live input.
  const observed = new Set()
  const sample = async () => observed.add(await inputValue(page, 'cell'))
  await sample()
  // Sample after every keystroke AND while the response lands, so a jump has
  // nowhere to hide.
  await type(cdp, page, 'lo world', sample)
  for (let i = 0; i < 30; i += 1) {
    await sample()
    await sleep(120)
  }

  const jumped = [...observed].filter((value) => value !== value.toLowerCase())
  check(
    'the input never showed the server value while the user was typing',
    jumped.length === 0,
    jumped.length ? `saw ${JSON.stringify(jumped)}` : `${observed.size} distinct values, all local`,
  )
  check(
    'the input holds exactly what was typed',
    (await inputValue(page, 'cell')) === 'hello world',
    JSON.stringify(await inputValue(page, 'cell')),
  )

  const log = await text(page, 'log')
  const puts = log.split('\n').filter((line) => line.includes('PUT'))
  check('the edit made during the flight went out afterwards', log.includes('"hello world"'))
  check('two requests for eleven keystrokes', puts.length === 2, `${puts.length} PUTs`)
  check('the response was discarded', log.includes('(discarded)'))
  const settled = await waitFor(async () => (await text(page, 'pending')).includes('none'))
  check('nothing is left pending once the second response lands', settled)

  // -------------------------------------------------------- 2: failure never rolls back
  await focus(page, 'flaky-cell')
  await type(cdp, page, 'draft')
  await sleep(2400) // first attempt at ~1s, second after a ~1s backoff

  check('a failing key stays pending', (await text(page, 'flaky-pending')).includes('B2'))
  check('the failure is reported', (await text(page, 'failed')).includes('failed: 1'))
  const attempts = Number((await text(page, 'attempts')).replace(/\D/g, ''))
  check('it retried on its own', attempts >= 2, `${attempts} attempts`)
  check('local state was not rolled back', (await inputValue(page, 'flaky-cell')) === 'draft')

  await type(cdp, page, '-more')
  await page.evaluate(`document.querySelector('[data-testid="retry"]').click()`)
  await sleep(1400)
  check(
    'the retry carried the current value, not the one that failed',
    (await text(page, 'flaky-log')).includes('"draft-more"'),
  )

  await page.evaluate(`document.querySelector('[data-testid="discard"]').click()`)
  await sleep(150)
  check('discard() is what drops it', (await text(page, 'flaky-pending')).includes('none'))

  // ---------------------------------------------------------------- 3: batch endpoint
  await focus(page, 'batch-c1')
  await type(cdp, page, 'one')
  await focus(page, 'batch-c3')
  await type(cdp, page, 'three')
  await sleep(1400)

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
