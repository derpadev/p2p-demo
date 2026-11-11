import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, 'site')
const resultsDir = path.join(here, 'results')
fs.mkdirSync(resultsDir, { recursive: true })

const mbps = Number(process.argv[2] ?? 0) // total CDN cap in Mbit/s, 0 = unlimited
const TICK_MS = 50
const budgetPerTick = (mbps * 1e6 / 8) * (TICK_MS / 1000)

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

setInterval(() => {
  if (!active.size) return
  const share = Math.max(1, Math.floor(budgetPerTick / active.size))
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
  fs.appendFileSync(serverFile(), JSON.stringify({
    t: Date.now() - runStart, servedBytes, segmentRequests, activeDownloads: active.size
  }) + '\n')
}, 1000)

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'no-store')

  if (url.pathname === '/__stats') {
    res.setHeader('Content-Type', 'application/json')
    return res.end(JSON.stringify({ servedBytes, segmentRequests, capMbps: mbps, logging, runName }))
  }

  if (url.pathname === '/__run') {
    runName = (url.searchParams.get('name') ?? 'run').replace(/[^a-zA-Z0-9_-]/g, '') || 'run'
    servedBytes = 0
    segmentRequests = 0
    runStart = Date.now()
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
        } catch {}
      }
      res.statusCode = 204
      res.end()
    })
    return
  }

  let rel = decodeURIComponent(url.pathname)
  if (rel === '/') rel = '/index.html'
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
})