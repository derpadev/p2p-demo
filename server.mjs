import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, 'site')
const resultsDir = path.join(here, 'results')
fs.mkdirSync(resultsDir, { recursive: true })

let mbps = Number(process.argv[2] ?? 0) // total CDN cap in Mbit/s, 0 = unlimited (changeable via /__cap)
const TICK_MS = 50
let budgetPerTick = (mbps * 1e6 / 8) * (TICK_MS / 1000)
const setCap = (n) => {
  mbps = n
  budgetPerTick = (mbps * 1e6 / 8) * (TICK_MS / 1000)
  console.log(`cap changed to ${mbps > 0 ? mbps + ' Mbit/s total' : 'unlimited'}`)
}

const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.mp4': 'video/mp4'
}

let servedBytes = 0
let segmentRequests = 0
const active = new Set() // throttled downloads in progress

// run recording
let logging = false
let runName = 'default'
let runStart = Date.now()
const peerFile = () => path.join(resultsDir, runName + '.jsonl')
const serverFile = () => path.join(resultsDir, runName + '.server.jsonl')

// live view of the current run, for the dashboard
const livePeers = new Map() // id -> latest report
let throughput = [] // { t, mbps } once per second
let lastServed = 0

setInterval(() => {
  if (!active.size) return
  const share = mbps > 0 ? Math.max(1, Math.floor(budgetPerTick / active.size)) : Infinity
  for (const d of active) {
    const n = Math.min(share, d.buf.length - d.pos)
    d.res.write(d.buf.subarray(d.pos, d.pos + n))
    d.pos += n
    servedBytes += n
    if (d.pos >= d.buf.length) { d.res.end(); active.delete(d) }
  }
}, TICK_MS)

setInterval(() => {
  if (!logging) return
  const t = Date.now() - runStart
  fs.appendFileSync(serverFile(), JSON.stringify({
    t, servedBytes, segmentRequests, activeDownloads: active.size, capMbps: mbps
  }) + '\n')
  throughput.push({ t, mbps: +((servedBytes - lastServed) * 8 / 1e6).toFixed(2) })
  lastServed = servedBytes
}, 1000)

// ---- dashboard demo runs: one launcher process at a time ----
const runScript = path.join(here, 'launcher', 'run.mjs')
const runSrc = fs.readFileSync(runScript, 'utf8')
const grab = (re) => runSrc.match(re)?.[1]
const literal = (src) => Function(`"use strict"; return (${src})`)()
const DEMO = {
  peers: 10,
  interval: 5,
  gapSec: 10,
  clipSec: Number(grab(/const CLIP_SEC = (\d+)/)),
  tailSec: Number(grab(/const TAIL_SEC = (\d+)/)),
  profiles: literal(grab(/const PROFILES = (\{[\s\S]*?\})/)),
  mix: literal(grab(/const MIX = (\[[\s\S]*?\])/))
}
DEMO.runSec = (DEMO.peers - 1) * DEMO.interval + DEMO.clipSec + DEMO.tailSec

const demo = { child: null, queue: [], current: null, stopping: false, gapTimer: null, log: [] }
const demoLog = (line) => { demo.log.push(line); if (demo.log.length > 300) demo.log.shift() }

function startNextDemoRun() {
  const next = demo.queue.shift()
  if (!next || demo.stopping) { demo.current = null; demo.queue = []; demo.stopping = false; return }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const name = `demo-${stamp}-${next.mode}`
  demo.current = { name, mode: next.mode, cap: next.cap, started: Date.now(), runSec: DEMO.runSec }
  setCap(next.cap)
  demoLog(`===== ${name}: ${next.mode === 'p2p' ? 'P2P' : 'CDN only'}, cap ${next.cap > 0 ? next.cap + ' Mbit/s' : 'unlimited'} =====`)
  const args = [runScript, name, '--peers', String(DEMO.peers), '--interval', String(DEMO.interval), '--stdin-stop']
  if (next.mode === 'cdn-only') args.push('--no-p2p')
  const child = spawn(process.execPath, args, { cwd: here })
  demo.child = child
  let partial = ''
  const onData = (chunk) => {
    const lines = (partial + chunk).split(/\r?\n/)
    partial = lines.pop()
    for (const l of lines) if (l.trim()) demoLog(l)
  }
  child.stdout.setEncoding('utf8').on('data', onData)
  child.stderr.setEncoding('utf8').on('data', onData)
  child.on('close', (code) => {
    if (partial.trim()) demoLog(partial)
    demoLog(`${name} finished${code ? ` (launcher exit code ${code})` : ''}`)
    demo.child = null
    if (demo.queue.length && !demo.stopping) {
      demoLog(`waiting ${DEMO.gapSec}s before the next run...`)
      demo.current = { ...demo.current, waitingUntil: Date.now() + DEMO.gapSec * 1000 }
      demo.gapTimer = setTimeout(() => { demo.gapTimer = null; startNextDemoRun() }, DEMO.gapSec * 1000)
    } else startNextDemoRun()
  })
}

function trackerUp() {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); try { ws.close() } catch {} resolve(v) } }
    const ws = new WebSocket('ws://localhost:8000')
    const timer = setTimeout(() => finish(false), 2000)
    ws.addEventListener('open', () => finish(true))
    ws.addEventListener('error', () => finish(false))
  })
}
let trackerOk = false
const checkTracker = async () => { trackerOk = await trackerUp() }
checkTracker()
setInterval(checkTracker, 3000)

function summarizeRun(name) {
  const last = new Map()
  let qSum = 0, qN = 0
  for (const line of fs.readFileSync(path.join(resultsDir, name + '.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue
    let r
    try { r = JSON.parse(line) } catch { continue }
    last.set(r.id, r)
    if (r.height > 0 && r.playTime < DEMO.clipSec - 1) { qSum += r.height; qN++ }
  }
  const srv = fs.readFileSync(path.join(resultsDir, name + '.server.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
  const lastSrv = srv.length ? JSON.parse(srv[srv.length - 1]) : {}
  const peers = [...last.values()]
  const sum = (f) => peers.reduce((s, p) => s + (f(p) ?? 0), 0)
  const started = peers.filter((p) => p.startupMs != null)
  const cdnPeers = sum((p) => p.cdnBytes)
  const p2pDown = sum((p) => p.p2pDown)
  return {
    name,
    mode: name.endsWith('-cdn-only') ? 'cdn-only' : 'p2p',
    date: fs.statSync(path.join(resultsDir, name + '.jsonl')).mtime.toISOString(),
    capMbps: lastSrv.capMbps ?? null,
    peers: peers.length,
    finished: peers.filter((p) => p.playTime >= DEMO.clipSec - 1).length,
    cdnMB: +((lastSrv.servedBytes ?? 0) / 1e6).toFixed(1),
    p2pMB: +(p2pDown / 1e6).toFixed(1),
    p2pShare: cdnPeers + p2pDown > 0 ? +(p2pDown / (cdnPeers + p2pDown)).toFixed(3) : 0,
    stalls: sum((p) => p.stalls),
    stallSec: +(sum((p) => p.stallMs) / 1000).toFixed(1),
    stalledPeers: peers.filter((p) => p.stalls > 0).length,
    meanStartupMs: started.length ? Math.round(started.reduce((s, p) => s + p.startupMs, 0) / started.length) : null,
    meanQuality: qN ? Math.round(qSum / qN) : null
  }
}

function demoHistory() {
  return fs.readdirSync(resultsDir)
    .filter((f) => /^demo-.*\.jsonl$/.test(f) && !f.endsWith('.server.jsonl'))
    .map((f) => f.slice(0, -'.jsonl'.length))
    .filter((n) => n !== demo.current?.name && fs.existsSync(path.join(resultsDir, n + '.server.jsonl')))
    .map((n) => { try { return summarizeRun(n) } catch { return null } })
    .filter(Boolean)
    .sort((a, b) => b.date.localeCompare(a.date))
}

const sendJson = (res, obj, status = 200) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(obj))
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'no-store')

  if (url.pathname === '/__stats') {
    return sendJson(res, { servedBytes, segmentRequests, capMbps: mbps, logging, runName })
  }

  if (url.pathname === '/__cap') {
    const n = Number(url.searchParams.get('mbps'))
    if (!url.searchParams.has('mbps') || !Number.isFinite(n) || n < 0) {
      return sendJson(res, { error: 'usage: /__cap?mbps=N (N >= 0, 0 = unlimited)', capMbps: mbps }, 400)
    }
    setCap(n)
    return sendJson(res, { capMbps: mbps })
  }

  if (url.pathname === '/__run') {
    runName = (url.searchParams.get('name') ?? 'run').replace(/[^a-zA-Z0-9_-]/g, '') || 'run'
    servedBytes = 0
    segmentRequests = 0
    runStart = Date.now()
    livePeers.clear()
    throughput = []
    lastServed = 0
    fs.writeFileSync(peerFile(), '')
    fs.writeFileSync(serverFile(), '')
    logging = true
    return res.end('recording run: ' + runName)
  }

  if (url.pathname === '/__stop') {
    logging = false
    return res.end('stopped run: ' + runName)
  }

  if (url.pathname === '/__report' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      if (logging) {
        try {
          const rec = JSON.parse(body)
          rec.t = Date.now() - runStart
          fs.appendFileSync(peerFile(), JSON.stringify(rec) + '\n')
          livePeers.set(rec.id, rec)
        } catch {}
      }
      res.statusCode = 204
      res.end()
    })
    return
  }

  if (url.pathname === '/__demo/status') {
    return sendJson(res, {
      config: DEMO,
      capMbps: mbps,
      tracker: trackerOk,
      busyElsewhere: logging && !demo.child,
      current: demo.current,
      queued: demo.queue.map((q) => q.mode),
      stopping: demo.stopping,
      recording: logging ? runName : null,
      elapsedMs: logging ? Date.now() - runStart : null,
      cdnServedBytes: servedBytes,
      throughput,
      peers: [...livePeers.values()].sort((a, b) => a.id.localeCompare(b.id)),
      log: demo.log.slice(-80)
    })
  }

  if (url.pathname === '/__demo/history') return sendJson(res, demoHistory())

  if (url.pathname === '/__demo/start' && req.method === 'POST') {
    const mode = url.searchParams.get('mode')
    const cap = Number(url.searchParams.get('cap'))
    if (!['p2p', 'cdn-only', 'both'].includes(mode)) return sendJson(res, { error: 'mode must be p2p, cdn-only or both' }, 400)
    if (!url.searchParams.has('cap') || !Number.isFinite(cap) || cap < 0) return sendJson(res, { error: 'cap must be a number >= 0 (0 = unlimited)' }, 400)
    if (demo.current || demo.child) return sendJson(res, { error: 'a demo run is already in progress' }, 409)
    if (logging) return sendJson(res, { error: `another run ("${runName}") is being recorded, probably from batch.mjs; wait for it to finish` }, 409)
    if (mode !== 'cdn-only' && !trackerOk) return sendJson(res, { error: 'the tracker is not running; start it with: node tracker.mjs' }, 409)
    demo.queue = mode === 'both' ? [{ mode: 'cdn-only', cap }, { mode: 'p2p', cap }] : [{ mode, cap }]
    demo.log = []
    startNextDemoRun()
    return sendJson(res, { ok: true })
  }

  if (url.pathname === '/__demo/stop' && req.method === 'POST') {
    if (!demo.current) return sendJson(res, { error: 'nothing is running' }, 409)
    demo.stopping = true
    demo.queue = []
    if (demo.child) { demoLog('stop requested'); demo.child.stdin.write('stop\n') } else {
      clearTimeout(demo.gapTimer)
      demo.gapTimer = null
      demoLog('stopped before the next run')
      startNextDemoRun()
    }
    return sendJson(res, { ok: true })
  }

  let rel = decodeURIComponent(url.pathname)
  if (rel === '/') rel = '/index.html'
  if (rel === '/dashboard') rel = '/dashboard.html'
  const file = path.normalize(path.join(root, rel))
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404
    return res.end('not found')
  }

  const ext = path.extname(file)
  const buf = fs.readFileSync(file)
  res.setHeader('Content-Type', types[ext] ?? 'application/octet-stream')
  res.setHeader('Content-Length', buf.length)

  if (ext === '.ts' && mbps > 0) {
    segmentRequests++
    res.on('close', () => { for (const d of active) if (d.res === res) active.delete(d) })
    active.add({ res, buf, pos: 0 })
  } else {
    if (ext === '.ts') { segmentRequests++; servedBytes += buf.length }
    res.end(buf)
  }
}).listen(8080, () => {
  console.log(`CDN server on http://localhost:8080  (cap: ${mbps > 0 ? mbps + ' Mbit/s total' : 'unlimited'})`)
  console.log('Dashboard:   http://localhost:8080/dashboard')
})
