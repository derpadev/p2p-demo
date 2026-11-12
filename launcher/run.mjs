import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = 'http://localhost:8080'
const here = path.dirname(fileURLToPath(import.meta.url))
const resultsDir = path.join(here, '..', 'results')

// ---- command line ----
const args = process.argv.slice(2)
if (!args[0] || args[0].startsWith('--')) {
  console.log('usage: node launcher\\run.mjs <run-name> [--peers N] [--interval SECONDS] [--no-p2p] [--headed]')
  process.exit(1)
}
const runName = args[0].replace(/[^a-zA-Z0-9_-]/g, '') || 'run'
const opt = (name, def) => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? Number(args[i + 1]) : def
}
const PEERS = opt('peers', 6)
const INTERVAL = opt('interval', 5) // seconds between joins
const HEADED = args.includes('--headed')
const NO_P2P = args.includes('--no-p2p')
const STDIN_STOP = args.includes('--stdin-stop') // used by the dashboard: a "stop" line on stdin ends the run early
const CLIP_SEC = 120
const TAIL_SEC = 60

// ---- hardware profiles (CPU slowdown factor) ----
const PROFILES = {
  strong: 1, // no throttling
  mid: 3,    // 3x slower CPU
  weak: 6    // 6x slower CPU
}
// fixed peer mix, repeated if there are more than 10 peers
const MIX = ['strong', 'weak', 'mid', 'strong', 'weak', 'mid', 'strong', 'weak', 'strong', 'mid']

let stopRequested = false
let wake = () => {}
const sleep = (ms) => new Promise((r) => {
  if (stopRequested) return r()
  const timer = setTimeout(r, ms)
  wake = () => { clearTimeout(timer); r() }
})
if (STDIN_STOP) {
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (d) => {
    if (d.includes('stop')) { stopRequested = true; console.log('stop requested, ending the run early'); wake() }
  })
}

try {
  await fetch(BASE + '/__stats')
} catch {
  console.log('The CDN server is not running. Start it first: node server.mjs 4')
  process.exit(1)
}

console.log(await (await fetch(`${BASE}/__run?name=${runName}`)).text())

const browser = await chromium.launch({
  channel: 'chrome',
  headless: !HEADED,
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=WebRtcHideLocalIpsWithMdns,CalculateNativeWinOcclusion',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows'
  ]
})

const t0 = Date.now()
const stamp = () => String(Math.round((Date.now() - t0) / 1000)).padStart(3) + 's'

try {
  for (let i = 0; i < PEERS; i++) {
    const wait = i * INTERVAL * 1000 - (Date.now() - t0)
    if (wait > 0) await sleep(wait)
    if (stopRequested) break

    const profile = MIX[i % MIX.length]
    const id = 'P' + String(i + 1).padStart(2, '0')

    const context = await browser.newContext({ viewport: { width: 480, height: 360 } })
    const page = await context.newPage()
    page.on('pageerror', (e) => console.log(id, 'page error:', e.message))

    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: PROFILES[profile] })

    await page.goto(`${BASE}/?id=${id}&profile=${profile}${NO_P2P ? '&p2p=0' : ''}`)
    console.log(`[${stamp()}] ${id} joined as ${profile} (CPU x${PROFILES[profile]})${NO_P2P ? ', CDN only' : ''}`)
  }

  if (!stopRequested) {
    const endAt = t0 + ((PEERS - 1) * INTERVAL + CLIP_SEC + TAIL_SEC) * 1000
    console.log(`[${stamp()}] all peers joined, waiting for the clip to finish...`)
    await sleep(Math.max(0, endAt - Date.now()))
  }
} finally {
  console.log(await (await fetch(BASE + '/__stop')).text())
  await browser.close()
  if (STDIN_STOP) process.stdin.destroy()
}

// ---- summary ----
const mb = (n) => +(n / 1e6).toFixed(1)
const last = new Map()
for (const line of fs.readFileSync(path.join(resultsDir, runName + '.jsonl'), 'utf8').split('\n')) {
  if (line.trim()) { const r = JSON.parse(line); last.set(r.id, r) }
}
console.table([...last.values()].map((r) => ({
  id: r.id, profile: r.profile, lastQuality: r.height,
  cdnMB: mb(r.cdnBytes), fromPeersMB: mb(r.p2pDown), uploadedMB: mb(r.p2pUp),
  stalls: r.stalls, stallSec: +(r.stallMs / 1000).toFixed(1), startupMs: r.startupMs
})))
const srvLines = fs.readFileSync(path.join(resultsDir, runName + '.server.jsonl'), 'utf8').trim().split('\n')
if (srvLines[0]) console.log('CDN served (server log):', mb(JSON.parse(srvLines.pop()).servedBytes), 'MB')