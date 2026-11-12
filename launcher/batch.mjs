import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = 'http://localhost:8080'
const TRACKER = 'ws://localhost:8000'
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const resultsDir = path.join(root, 'results')
const runScript = path.join(here, 'run.mjs')

// ---- command line ----
const usage = 'usage: node launcher\\batch.mjs <group> [--runs 5] [--peers N] [--interval SEC] [--cap MBPS] [--gap SEC] [--no-p2p] [--overwrite]'
const args = process.argv.slice(2)
if (!args[0] || args[0].startsWith('--')) { console.log(usage); process.exit(1) }
const group = args[0]
if (!/^[a-zA-Z0-9_-]+$/.test(group)) {
  console.log(`Group name "${group}" may only contain letters, digits, "-" and "_" (the server strips anything else from run names).`)
  process.exit(1)
}
const opt = (name) => {
  const i = args.indexOf('--' + name)
  if (i < 0) return undefined
  const n = Number(args[i + 1])
  if (args[i + 1] === undefined || !Number.isFinite(n) || n < 0) {
    console.log(`--${name} needs a non-negative number.\n${usage}`)
    process.exit(1)
  }
  return n
}
const RUNS = opt('runs') ?? 5
const CAP = opt('cap')
const GAP = opt('gap') ?? 10
const OVERWRITE = args.includes('--overwrite')
const NO_P2P = args.includes('--no-p2p')

// ---- read the launcher's fixed settings from its source, so the config records exactly what run.mjs used ----
const runSrc = fs.readFileSync(runScript, 'utf8')
const grab = (re, what) => {
  const m = runSrc.match(re)
  if (!m) { console.log(`Could not find ${what} in launcher\\run.mjs; batch.mjs needs it to record the config.`); process.exit(1) }
  return m[1]
}
const literal = (src) => Function(`"use strict"; return (${src})`)()
const PROFILES = literal(grab(/const PROFILES = (\{[\s\S]*?\})/, 'PROFILES'))
const MIX = literal(grab(/const MIX = (\[[\s\S]*?\])/, 'MIX'))
const CLIP_SEC = Number(grab(/const CLIP_SEC = (\d+)/, 'CLIP_SEC'))
const TAIL_SEC = Number(grab(/const TAIL_SEC = (\d+)/, 'TAIL_SEC'))
const PEERS = opt('peers') ?? Number(grab(/opt\('peers', (\d+)\)/, 'default --peers'))
const INTERVAL = opt('interval') ?? Number(grab(/opt\('interval', (\d+)\)/, 'default --interval'))
if (!Number.isInteger(PEERS) || PEERS < 1) { console.log('--peers must be a whole number >= 1'); process.exit(1) }
if (!Number.isInteger(RUNS) || RUNS < 1) { console.log('--runs must be a whole number >= 1'); process.exit(1) }

const peerIds = Array.from({ length: PEERS }, (_, i) => 'P' + String(i + 1).padStart(2, '0'))
const assigned = peerIds.map((id, i) => ({ id, profile: MIX[i % MIX.length], cpuThrottle: PROFILES[MIX[i % MIX.length]] }))

const playlistSec = fs.readFileSync(path.join(root, 'site', 'stream', 'stream_0.m3u8'), 'utf8')
  .split('\n').filter((l) => l.startsWith('#EXTINF:'))
  .reduce((s, l) => s + parseFloat(l.slice(8)), 0)

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex').slice(0, 16)
const indexHtml = fs.readFileSync(path.join(root, 'site', 'index.html'), 'utf8')
const libVersions = {
  'hls.js': indexHtml.match(/hls\.js@([\d.]+)/)?.[1] ?? 'unknown',
  'p2p-media-loader': indexHtml.match(/p2p-media-loader-core@([\d.]+)/)?.[1] ?? 'unknown'
}

// ---- helpers ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stamp = () => new Date().toLocaleTimeString()

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
  const text = await res.text()
  try { return { ok: res.ok, status: res.status, body: JSON.parse(text) } } catch { return { ok: false, status: res.status, body: text } }
}

async function serverUp() {
  try { const r = await getJson(BASE + '/__stats'); return r.ok ? r.body : null } catch { return null }
}

function trackerUp() {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); try { ws.close() } catch {} resolve(v) } }
    const ws = new WebSocket(TRACKER)
    const timer = setTimeout(() => finish(false), 3000)
    ws.addEventListener('open', () => finish(true))
    ws.addEventListener('error', () => finish(false))
  })
}

const logFile = path.join(resultsDir, group + '.batch.log')
const log = (line) => { console.log(line); fs.appendFileSync(logFile, line + '\n') }

// ---- preflight ----
fs.mkdirSync(resultsDir, { recursive: true })

if (!(await serverUp())) {
  console.log(`The CDN server is not responding at ${BASE}/__stats.\nStart it first in its own window:  node server.mjs <capMbps>`)
  process.exit(1)
}
if (!(await trackerUp())) {
  console.log(`The tracker is not responding at ${TRACKER}.\nStart it first in its own window:  node tracker.mjs`)
  process.exit(1)
}

const existing = fs.readdirSync(resultsDir).filter((f) => f.startsWith(group + '-r') || f.startsWith(group + '.'))
if (existing.length && !OVERWRITE) {
  console.log(`results\\ already has files for group "${group}":\n  ${existing.join('\n  ')}\n` +
    'Pick a new group name, or add --overwrite to delete these first.')
  process.exit(1)
}
if (OVERWRITE) {
  // only this group's files: "<group>-r<N>.*" and "<group>.*"
  const own = new RegExp(`^${group}(-r\\d+)?\\.`)
  for (const f of existing) if (own.test(f)) fs.rmSync(path.join(resultsDir, f))
}

if (CAP !== undefined) {
  let r
  try { r = await getJson(`${BASE}/__cap?mbps=${CAP}`) } catch (e) { r = { ok: false, body: e.message } }
  if (!r.ok) {
    console.log(`Setting the cap failed (${r.status ?? ''} ${JSON.stringify(r.body)}).\n` +
      'If the response is "not found", the running server predates /__cap: restart it with  node server.mjs <capMbps>')
    process.exit(1)
  }
}
const stats = await serverUp()

const config = {
  group,
  runs: RUNS,
  peers: PEERS,
  interval: INTERVAL,
  capMbps: stats.capMbps,
  capSetByBatch: CAP !== undefined,
  gapSec: GAP,
  p2p: !NO_P2P,
  mix: MIX,
  profiles: PROFILES,
  assignedPeers: assigned,
  clipSec: CLIP_SEC,
  playlistSec: Math.round(playlistSec * 10) / 10,
  tailSec: TAIL_SEC,
  libraries: libVersions,
  codeHashes: { 'launcher/run.mjs': sha('launcher/run.mjs'), 'site/index.html': sha('site/index.html'), 'server.mjs': sha('server.mjs') },
  date: new Date().toISOString(),
  finished: null,
  results: []
}
const configFile = path.join(resultsDir, group + '.config.json')
const saveConfig = () => fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n')
saveConfig()

log(`[${stamp()}] batch "${group}": ${NO_P2P ? 'CDN only, ' : ''}${RUNS} runs x ${PEERS} peers, join every ${INTERVAL}s, CDN cap ${stats.capMbps > 0 ? stats.capMbps + ' Mbit/s' : 'unlimited'}, gap ${GAP}s`)

// ---- check one run's output files ----
function checkRun(name) {
  const issues = []
  const peerFile = path.join(resultsDir, name + '.jsonl')
  const srvFile = path.join(resultsDir, name + '.server.jsonl')
  const last = new Map()
  let badLines = 0
  if (fs.existsSync(peerFile)) {
    for (const line of fs.readFileSync(peerFile, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { const r = JSON.parse(line); last.set(r.id, r) } catch { badLines++ }
    }
  } else issues.push('peer log missing')
  if (badLines) issues.push(`${badLines} unreadable line(s) in peer log`)
  const serverRows = fs.existsSync(srvFile) ? fs.readFileSync(srvFile, 'utf8').split('\n').filter((l) => l.trim()).length : 0
  if (!serverRows) issues.push('server log missing or empty')

  const missingPeers = peerIds.filter((id) => !last.has(id))
  const neverStarted = [...last.values()].filter((r) => r.startupMs == null).map((r) => r.id)
  const notFinished = [...last.values()].filter((r) => !(r.playTime >= 119)).map((r) => `${r.id} (playTime ${r.playTime})`)
  if (missingPeers.length) issues.push(`no data from ${missingPeers.join(', ')}`)
  if (neverStarted.length) issues.push(`playback never started: ${neverStarted.join(', ')}`)
  if (notFinished.length) issues.push(`did not reach end of clip: ${notFinished.join(', ')}`)
  return { peersWithData: last.size, missingPeers, neverStarted, notFinished, serverRows, issues }
}

// ---- runs ----
let crashed = 0
for (let n = 1; n <= RUNS; n++) {
  const name = `${group}-r${n}`
  const entry = { run: name, status: 'running', started: new Date().toISOString() }
  config.results.push(entry)

  const pre = await serverUp()
  if (!pre || !(await trackerUp())) {
    entry.status = 'skipped'
    entry.issues = [!pre ? 'CDN server stopped responding before this run' : 'tracker stopped responding before this run']
    log(`[${stamp()}] ${name}: SKIPPED, ${entry.issues[0]}; stopping the batch`)
    saveConfig()
    crashed++
    break
  }
  entry.capMbps = pre.capMbps

  log(`\n[${stamp()}] ===== ${name} (${n}/${RUNS}) =====`)
  const child = spawn(process.execPath, [runScript, name, '--peers', String(PEERS), '--interval', String(INTERVAL), ...(NO_P2P ? ['--no-p2p'] : [])], { cwd: root })
  const tee = (chunk) => { process.stdout.write(chunk); fs.appendFileSync(logFile, chunk) }
  child.stdout.on('data', tee)
  child.stderr.on('data', tee)
  const exitCode = await new Promise((r) => child.on('close', (code) => r(code)))

  Object.assign(entry, { ended: new Date().toISOString(), exitCode }, checkRun(name))
  if (exitCode !== 0) { entry.issues.unshift(`launcher exited with code ${exitCode}`); crashed++ }
  entry.status = exitCode !== 0 ? 'crashed' : entry.issues.length ? 'completed with issues' : 'ok'
  saveConfig()
  log(`[${stamp()}] ${name}: ${entry.status}${entry.issues.length ? ' -> ' + entry.issues.join('; ') : ''}`)

  if (n < RUNS) {
    log(`[${stamp()}] waiting ${GAP}s before the next run...`)
    await sleep(GAP * 1000)
  }
}

config.finished = new Date().toISOString()
saveConfig()

log(`\n[${stamp()}] batch "${group}" done:`)
for (const r of config.results) log(`  ${r.run.padEnd(20)} ${r.status}${r.issues?.length ? '  (' + r.issues.join('; ') + ')' : ''}`)
log(`config: results\\${group}.config.json   log: results\\${group}.batch.log`)
log(`next:   node analysis\\analyze.mjs ${group}`)
process.exit(crashed ? 1 : 0)
