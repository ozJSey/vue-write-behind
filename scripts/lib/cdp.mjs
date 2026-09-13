/**
 * Minimal Chrome DevTools Protocol client — zero dependencies, Node 22+ (the
 * global `WebSocket` landed there).
 *
 * Copied verbatim from `playground/scripts/lib/cdp.mjs` rather than imported:
 * every package in this portfolio stands alone, and a dev-only script must not
 * make this one depend on the playground's layout. Only `browser-check.mjs`
 * uses it, and nothing here is published (`files: ["dist"]`).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)

export function findChrome() {
  const found = CHROME_CANDIDATES.find((p) => existsSync(p))
  if (!found) throw new Error('No Chrome found. Set CHROME_PATH.')
  return found
}

export async function launchChrome({ port = 9333, headless = true } = {}) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'wb-cdp-'))
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--window-size=1280,1400',
    'about:blank',
  ]
  if (headless) args.unshift('--headless=new')
  const proc = spawn(findChrome(), args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  proc.stdout.on('data', (c) => (log += c))
  proc.stderr.on('data', (c) => (log += c))

  let version
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) { version = await res.json(); break }
    } catch { /* not up */ }
    await sleep(250)
  }
  if (!version) { proc.kill('SIGKILL'); throw new Error(`Chrome never exposed CDP:\n${log}`) }
  return { proc, wsUrl: version.webSocketDebuggerUrl, port }
}

export class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.listeners = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`))
        else p.resolve(msg.result)
      } else {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params, msg.sessionId)
      }
    })
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true })
    })
    return new Cdp(ws)
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, [])
    this.listeners.get(method).push(fn)
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    this.ws.send(JSON.stringify(payload))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  close() { try { this.ws.close() } catch { /* already gone */ } }
}

/** Attach to a fresh tab and return a page handle with evaluate/navigate. */
export async function newPage(cdp, url = 'about:blank') {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })

  const consoleErrors = []
  const pageErrors = []
  cdp.on('Runtime.consoleAPICalled', (p, sid) => {
    if (sid !== sessionId) return
    if (p.type === 'error') {
      consoleErrors.push(p.args.map((a) => a.value ?? a.description ?? a.type).join(' '))
    }
  })
  cdp.on('Runtime.exceptionThrown', (p, sid) => {
    if (sid !== sessionId) return
    const d = p.exceptionDetails
    pageErrors.push(d.exception?.description ?? d.text)
  })

  await cdp.send('Runtime.enable', {}, sessionId)
  await cdp.send('Page.enable', {}, sessionId)

  const page = {
    sessionId,
    targetId,
    consoleErrors,
    pageErrors,
    async navigate(u) {
      const loaded = new Promise((resolve) => {
        const fn = (_p, sid) => { if (sid === sessionId) resolve() }
        cdp.on('Page.loadEventFired', fn)
      })
      await cdp.send('Page.navigate', { url: u }, sessionId)
      await Promise.race([loaded, sleep(15000)])
    },
    async evaluate(fnOrExpr, ...args) {
      const expr =
        typeof fnOrExpr === 'function'
          ? `(${fnOrExpr.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`
          : fnOrExpr
      const res = await cdp.send(
        'Runtime.evaluate',
        { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true },
        sessionId,
      )
      if (res.exceptionDetails) {
        throw new Error(
          res.exceptionDetails.exception?.description ?? res.exceptionDetails.text,
        )
      }
      return res.result.value
    },
    async screenshot(path) {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId)
      const { writeFileSync } = await import('node:fs')
      writeFileSync(path, Buffer.from(data, 'base64'))
      return path
    },
  }
  if (url !== 'about:blank') await page.navigate(url)
  return page
}

export { sleep }
