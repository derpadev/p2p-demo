import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const resultsDir = path.join(here, '..', 'results')
const outDir = path.join(resultsDir, 'summary')
const CHART_JS = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js'
const END_PLAYTIME = 119 // pages keep reporting after the 120 s clip ends
const BUCKET_SEC = 5
const COLORS = ['#3b82f6', '#f97316']

// ---- command line ----
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
if (args.length < 1 || args.length > 2) {
  console.log('usage: node analysis\\analyze.mjs <groupA> [groupB]')
  process.exit(1)
}

// ---- small helpers ----
const readLines = (file) => {
  let bad = 0
  const rows = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch { bad++ }
  }
  return { rows, bad }
}
const sum = (xs) => xs.reduce((s, x) => s + x, 0)
const mean = (xs) => (xs.length ? sum(xs) / xs.length : null)
const agg = (vals) => {
  const v = vals.filter((x) => x != null && Number.isFinite(x))
  if (!v.length) return { mean: null, min: null, max: null, n: 0 }
  return { mean: mean(v), min: Math.min(...v), max: Math.max(...v), n: v.length }
}
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const MB = (b) => (b == null ? null : b / 1e6)
const fmt = (x, d = 1) => (x == null ? '–' : Number(x).toFixed(d))
const fmtAgg = (a, d = 1, k = 1) => (a.mean == null ? '–' : `${fmt(a.mean * k, d)} <span class="rng">[${fmt(a.min * k, d)}–${fmt(a.max * k, d)}]</span>`)

function knownGroups() {
  if (!fs.existsSync(resultsDir)) return []
  const set = new Set()
  for (const f of fs.readdirSync(resultsDir)) {
    const m = f.match(/^(.+)-r\d+\.jsonl$/)
    if (m) set.add(m[1])
  }
  return [...set].sort()
}

// ---- one run ----
function analyzeRun(group, n, config, profileOrder) {
  const name = `${group}-r${n}`
  const issues = []
  const { rows, bad } = readLines(path.join(resultsDir, name + '.jsonl'))
  if (bad) issues.push(`${bad} unreadable line(s) in ${name}.jsonl`)
  if (!rows.length) issues.push('peer log is empty')

  const srvFile = path.join(resultsDir, name + '.server.jsonl')
  const srv = fs.existsSync(srvFile) ? readLines(srvFile).rows : []
  if (!srv.length) issues.push('server log missing or empty, CDN total unknown')
  const cdnServer = srv.length ? srv[srv.length - 1].servedBytes : null

  const byPeer = new Map()
  for (const r of rows) {
    if (!byPeer.has(r.id)) byPeer.set(r.id, [])
    byPeer.get(r.id).push(r)
  }
  const peers = [...byPeer.entries()].map(([id, rs]) => {
    rs.sort((a, b) => a.t - b.t)
    return { id, profile: rs[0].profile, rows: rs, last: rs[rs.length - 1] }
  }).sort((a, b) => a.id.localeCompare(b.id))

  if (config) {
    const expected = Array.from({ length: config.peers }, (_, i) => 'P' + String(i + 1).padStart(2, '0'))
    const missing = expected.filter((id) => !byPeer.has(id))
    if (missing.length) issues.push(`no data from ${missing.join(', ')}`)
  }
  const neverStarted = peers.filter((p) => p.last.startupMs == null).map((p) => p.id)
  if (neverStarted.length) issues.push(`playback never started: ${neverStarted.join(', ')}`)
  const notFinished = peers.filter((p) => !(p.last.playTime >= END_PLAYTIME))
  if (notFinished.length) issues.push(`did not reach end of clip: ${notFinished.map((p) => `${p.id} (playTime ${p.last.playTime})`).join(', ')}`)

  const entry = config?.results?.find((r) => r.run === name)
  if (entry && entry.exitCode != null && entry.exitCode !== 0) issues.unshift(`launcher exited with code ${entry.exitCode}`)

  for (const p of peers) if (!profileOrder.includes(p.profile)) profileOrder.push(p.profile)

  const totalUp = sum(peers.map((p) => p.last.p2pUp))
  const perProfile = {}
  for (const prof of profileOrder) {
    const ps = peers.filter((p) => p.profile === prof)
    if (!ps.length) continue
    const started = ps.filter((p) => p.last.startupMs != null)
    const secondsAt = {}
    for (const p of ps) {
      for (const r of p.rows) {
        if (r.height > 0 && r.playTime < END_PLAYTIME) secondsAt[r.height] = (secondsAt[r.height] ?? 0) + 1
      }
    }
    for (const h of Object.keys(secondsAt)) secondsAt[h] /= ps.length
    const up = sum(ps.map((p) => p.last.p2pUp))
    perProfile[prof] = {
      peers: ps.length,
      stalls: sum(ps.map((p) => p.last.stalls)),
      stallSec: sum(ps.map((p) => p.last.stallMs)) / 1000,
      stalledShare: ps.filter((p) => p.last.stalls > 0).length / ps.length,
      meanStartupMs: mean(started.map((p) => p.last.startupMs)),
      uploadBytes: up,
      uploadPerPeer: up / ps.length,
      uploadShare: totalUp > 0 ? up / totalUp : null,
      secondsAt
    }
  }

  // mean height per 5 s bucket: average each peer within the bucket, then average across peers
  const buckets = new Map()
  for (const p of peers) {
    const own = new Map()
    for (const r of p.rows) {
      if (!(r.height > 0) || r.playTime >= END_PLAYTIME) continue
      const b = Math.floor(r.t / 1000 / BUCKET_SEC)
      if (!own.has(b)) own.set(b, [])
      own.get(b).push(r.height)
    }
    for (const [b, hs] of own) {
      if (!buckets.has(b)) buckets.set(b, [])
      buckets.get(b).push(mean(hs))
    }
  }
  const qualityTime = new Map([...buckets].map(([b, v]) => [b, mean(v)]))

  const cdnPeers = sum(peers.map((p) => p.last.cdnBytes))
  const p2pDown = sum(peers.map((p) => p.last.p2pDown))
  return {
    name, n, issues,
    status: entry?.status ?? (issues.length ? 'completed with issues' : 'ok'),
    peersWithData: peers.length,
    peerIds: peers.map((p) => p.id),
    perProfile, qualityTime,
    totals: {
      cdnServer, cdnPeers, p2pDown, p2pUp: totalUp,
      p2pShare: p2pDown + cdnPeers > 0 ? p2pDown / (p2pDown + cdnPeers) : null,
      stallSec: sum(peers.map((p) => p.last.stallMs)) / 1000
    }
  }
}

// ---- one group ----
function loadGroup(group) {
  const re = new RegExp(`^${escRe(group)}-r(\\d+)\\.jsonl$`)
  const files = fs.existsSync(resultsDir)
    ? fs.readdirSync(resultsDir).map((f) => f.match(re)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b)
    : []
  if (!files.length) {
    const known = knownGroups()
    console.error(`No runs found for group "${group}": expected files like results\\${group}-r1.jsonl.\n` +
      (known.length ? `Groups that do exist: ${known.join(', ')}` : 'There are no batch results in results\\ yet. Run: node launcher\\batch.mjs <group>'))
    process.exit(1)
  }

  const cfgFile = path.join(resultsDir, group + '.config.json')
  const config = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : null
  const groupIssues = []
  if (!config) groupIssues.push(`no ${group}.config.json: these runs were not made with batch.mjs, so the config and expected peer list are unknown`)

  const profileOrder = config ? Object.keys(config.profiles).sort((a, b) => config.profiles[a] - config.profiles[b]) : ['strong', 'mid', 'weak']
  const runs = files.map((n) => analyzeRun(group, n, config, profileOrder))

  if (config) {
    if (config.runs !== runs.length) groupIssues.push(`config asked for ${config.runs} runs, found data for ${runs.length}`)
    for (const r of config.results ?? []) {
      if (!files.includes(Number(r.run.split('-r').pop()))) groupIssues.push(`${r.run}: ${r.status}, no data file (${(r.issues ?? []).join('; ') || 'no details'})`)
    }
    if (!config.finished) groupIssues.push('batch did not record a finish time (it was interrupted or is still running)')
    const caps = [...new Set((config.results ?? []).map((r) => r.capMbps).filter((c) => c != null))]
    if (caps.length > 1) groupIssues.push(`CDN cap changed between runs: ${caps.join(', ')} Mbit/s`)
  }

  const profiles = profileOrder.filter((p) => runs.some((r) => r.perProfile[p]))
  const heights = [...new Set(runs.flatMap((r) => Object.values(r.perProfile).flatMap((pp) => Object.keys(pp.secondsAt).map(Number))))].sort((a, b) => a - b)

  const A = { profiles: {}, secondsAt: {}, totals: {}, qualityTime: [] }
  for (const p of profiles) {
    const present = runs.filter((r) => r.perProfile[p]).map((r) => r.perProfile[p])
    A.profiles[p] = {}
    for (const k of ['peers', 'stalls', 'stallSec', 'stalledShare', 'meanStartupMs', 'uploadBytes', 'uploadPerPeer', 'uploadShare']) {
      A.profiles[p][k] = agg(present.map((x) => x[k]))
    }
    A.secondsAt[p] = {}
    for (const h of heights) A.secondsAt[p][h] = agg(present.map((x) => x.secondsAt[h] ?? 0))
  }
  for (const k of ['cdnServer', 'cdnPeers', 'p2pDown', 'p2pUp', 'p2pShare', 'stallSec']) A.totals[k] = agg(runs.map((r) => r.totals[k]))
  const allBuckets = [...new Set(runs.flatMap((r) => [...r.qualityTime.keys()]))].sort((a, b) => a - b)
  for (const b of allBuckets) A.qualityTime.push({ t: b * BUCKET_SEC, ...agg(runs.map((r) => r.qualityTime.get(b))) })

  const peersLabel = config?.peers ?? Math.max(...runs.map((r) => r.peersWithData))
  return { group, config, runs, groupIssues, profiles, heights, A, peersLabel }
}

const groups = args.map(loadGroup)

// ---- CSV ----
fs.mkdirSync(outDir, { recursive: true })
const csvCell = (v) => {
  if (v == null) return ''
  const s = typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const writeCsv = (file, header, rows) => {
  fs.writeFileSync(path.join(outDir, file), [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n')
  return path.join('results', 'summary', file)
}
const written = []
for (const g of groups) {
  written.push(writeCsv(`${g.group}_runs.csv`,
    ['run', 'status', 'peersWithData', 'cdnServerBytes', 'cdnPeerReportedBytes', 'p2pDownBytes', 'p2pUpBytes', 'p2pShare', 'stallSecTotal', 'issues'],
    g.runs.map((r) => [r.name, r.status, r.peersWithData, r.totals.cdnServer, r.totals.cdnPeers, r.totals.p2pDown, r.totals.p2pUp, r.totals.p2pShare, r.totals.stallSec, r.issues.join('; ')])))

  const pk = ['peers', 'stalls', 'stallSec', 'stalledShare', 'meanStartupMs', 'uploadBytes', 'uploadPerPeer', 'uploadShare']
  const profRows = []
  for (const r of g.runs) for (const p of g.profiles) if (r.perProfile[p]) profRows.push([r.name, p, ...pk.map((k) => r.perProfile[p][k])])
  for (const s of ['mean', 'min', 'max']) for (const p of g.profiles) profRows.push([s, p, ...pk.map((k) => g.A.profiles[p][k][s])])
  written.push(writeCsv(`${g.group}_profiles.csv`, ['run', 'profile', ...pk], profRows))

  written.push(writeCsv(`${g.group}_quality_over_time.csv`,
    ['bucketStartSec', ...g.runs.map((r) => r.name), 'mean', 'min', 'max', 'runsWithData'],
    g.A.qualityTime.map((q) => [q.t, ...g.runs.map((r) => r.qualityTime.get(q.t / BUCKET_SEC)), q.mean, q.min, q.max, q.n])))

  const qsRows = []
  for (const r of g.runs) for (const p of g.profiles) if (r.perProfile[p]) for (const h of g.heights) qsRows.push([r.name, p, h, r.perProfile[p].secondsAt[h] ?? 0])
  for (const s of ['mean', 'min', 'max']) for (const p of g.profiles) for (const h of g.heights) qsRows.push([s, p, h, g.A.secondsAt[p][h][s]])
  written.push(writeCsv(`${g.group}_quality_seconds.csv`, ['run', 'profile', 'height', 'secondsPerPeer'], qsRows))
}

// ---- HTML report ----
const label = (g) => `${g.group}: ${g.runs.length} run${g.runs.length === 1 ? '' : 's'} × ${g.peersLabel} peers`
const allProfiles = [...new Set(groups.flatMap((g) => g.profiles))]
const weakName = (() => {
  const cfg = groups.find((g) => g.config)?.config
  if (cfg) return Object.keys(cfg.profiles).sort((a, b) => cfg.profiles[b] - cfg.profiles[a])[0]
  return allProfiles.includes('weak') ? 'weak' : allProfiles[allProfiles.length - 1]
})()
const throttleOf = (p) => groups.find((g) => g.config)?.config.profiles[p]

const chartData = {
  weak: weakName,
  profiles: allProfiles,
  maxRuns: Math.max(...groups.map((g) => g.runs.length)),
  groups: groups.map((g, i) => ({
    name: g.group,
    label: label(g),
    color: COLORS[i],
    quality: g.A.qualityTime.map((q) => ({ x: q.t, mean: q.mean, min: q.min, max: q.max })),
    stallSec: allProfiles.map((p) => g.A.profiles[p]?.stallSec ?? null),
    upload: allProfiles.map((p) => {
      const a = g.A.profiles[p]?.uploadBytes
      return a ? { mean: MB(a.mean), min: MB(a.min), max: MB(a.max) } : null
    }),
    cdnPerRun: g.runs.map((r) => ({ run: 'r' + r.n, mb: MB(r.totals.cdnServer) }))
  }))
}

const issuesHtml = (() => {
  const items = []
  for (const g of groups) {
    for (const s of g.groupIssues) items.push(`<li><b>${esc(g.group)}</b>: ${esc(s)}</li>`)
    for (const r of g.runs) for (const s of r.issues) items.push(`<li><b>${esc(r.name)}</b>: ${esc(s)}</li>`)
  }
  return items.length
    ? `<div class="issues"><h2>Failures and missing data (${items.length})</h2><ul>${items.join('')}</ul></div>`
    : '<div class="ok">No failures or missing data recorded for these runs.</div>'
})()

const configRows = (() => {
  const v = (g, fn) => { try { return g.config ? fn(g.config) : '<i>no config file</i>' } catch { return '–' } }
  const row = (name, fn) => `<tr><th>${name}</th>${groups.map((g) => `<td>${v(g, fn)}</td>`).join('')}</tr>`
  return [
    row('Runs (requested / with data)', (c) => `${c.runs} / ${groups.find((g) => g.config === c).runs.length}`),
    row('Peers per run', (c) => c.peers),
    row('Join interval', (c) => `${c.interval} s`),
    row('CDN cap', (c) => (c.capMbps > 0 ? `${c.capMbps} Mbit/s total` : 'unlimited') + (c.capSetByBatch ? ' (set by batch)' : ' (server setting)')),
    row('Gap between runs', (c) => `${c.gapSec} s`),
    row('Peers assigned', (c) => c.assignedPeers.map((p) => `${p.id} ${p.profile} x${p.cpuThrottle}`).join('<br>')),
    row('Profiles (CPU throttle)', (c) => Object.entries(c.profiles).map(([k, x]) => `${esc(k)} x${x}`).join(', ')),
    row('Fixed mix (repeats)', (c) => c.mix.join(', ')),
    row('Clip length', (c) => `${c.clipSec} s (playlist ${c.playlistSec} s), +${c.tailSec} s tail`),
    row('Libraries', (c) => Object.entries(c.libraries).map(([k, x]) => `${esc(k)} ${esc(x)}`).join(', ')),
    row('Code hashes', (c) => Object.entries(c.codeHashes).map(([k, x]) => `${esc(k)} <code>${x}</code>`).join('<br>')),
    row('Date', (c) => `${esc(c.date)}${c.finished ? '<br>finished ' + esc(c.finished) : ''}`),
    row('Run status', (c) => (c.results ?? []).map((r) => `${esc(r.run)}: ${esc(r.status)}`).join('<br>'))
  ].join('')
})()

const sameCode = groups.length === 2 && groups.every((g) => g.config) &&
  ['launcher/run.mjs', 'site/index.html', 'server.mjs'].map((f) => groups[0].config.codeHashes[f] === groups[1].config.codeHashes[f])

const profileTable = groups.map((g) => `
  <h3>${esc(label(g))}</h3>
  <table><tr><th>Profile</th><th>Peers / run</th><th>Stall count</th><th>Stall seconds</th><th>Peers that stalled</th><th>Mean startup (ms)</th><th>Upload (MB)</th><th>Upload per peer (MB)</th><th>Share of P2P upload</th></tr>
  ${g.profiles.map((p) => {
    const a = g.A.profiles[p]
    return `<tr${p === weakName ? ' class="weak"' : ''}><td>${esc(p)}${throttleOf(p) ? ` (x${throttleOf(p)})` : ''}</td><td>${fmt(a.peers.mean, 0)}</td><td>${fmtAgg(a.stalls)}</td><td>${fmtAgg(a.stallSec)}</td><td>${fmtAgg(a.stalledShare, 0, 100)} %</td><td>${fmtAgg(a.meanStartupMs, 0)}</td><td>${fmtAgg(a.uploadBytes, 1, 1e-6)}</td><td>${fmtAgg(a.uploadPerPeer, 1, 1e-6)}</td><td>${fmtAgg(a.uploadShare, 0, 100)} %</td></tr>`
  }).join('')}</table>`).join('')

const qualitySecondsTable = groups.map((g) => `
  <h3>${esc(label(g))}</h3>
  <table><tr><th>Profile</th>${g.heights.map((h) => `<th>${h}p (s per peer)</th>`).join('')}</tr>
  ${g.profiles.map((p) => `<tr${p === weakName ? ' class="weak"' : ''}><td>${esc(p)}</td>${g.heights.map((h) => `<td>${fmtAgg(g.A.secondsAt[p][h])}</td>`).join('')}</tr>`).join('')}</table>`).join('')

const totalsTable = `<table><tr><th></th>${groups.map((g) => `<th>${esc(label(g))}</th>`).join('')}</tr>
  ${[['CDN bytes, server log (MB)', 'cdnServer', 1, 1e-6], ['CDN bytes, peer-reported (MB)', 'cdnPeers', 1, 1e-6], ['P2P downloaded (MB)', 'p2pDown', 1, 1e-6], ['P2P uploaded (MB)', 'p2pUp', 1, 1e-6], ['P2P share of downloads', 'p2pShare', 0, 100, ' %'], ['Stall seconds, all peers', 'stallSec', 1, 1]]
    .map(([name, k, d, f, unit = '']) => `<tr><th>${name}</th>${groups.map((g) => `<td>${fmtAgg(g.A.totals[k], d, f)}${unit}</td>`).join('')}</tr>`).join('')}</table>`

const runsTable = groups.map((g) => `
  <h3>${esc(label(g))}</h3>
  <table><tr><th>Run</th><th>Status</th><th>Peers with data</th><th>CDN (MB)</th><th>P2P down (MB)</th><th>P2P up (MB)</th><th>Stall s</th><th>Issues</th></tr>
  ${g.runs.map((r) => `<tr${r.issues.length ? ' class="bad"' : ''}><td>${esc(r.name)}</td><td>${esc(r.status)}</td><td>${r.peersWithData}</td><td>${fmt(MB(r.totals.cdnServer))}</td><td>${fmt(MB(r.totals.p2pDown))}</td><td>${fmt(MB(r.totals.p2pUp))}</td><td>${fmt(r.totals.stallSec)}</td><td>${esc(r.issues.join('; ')) || '–'}</td></tr>`).join('')}</table>`).join('')

const weakCallout = groups.map((g) => {
  const w = g.A.profiles[weakName]
  if (!w) return `<li><b>${esc(g.group)}</b>: no ${esc(weakName)} peers in these runs.</li>`
  const others = g.profiles.filter((p) => p !== weakName).map((p) => `${esc(p)} ${fmt(MB(g.A.profiles[p].uploadPerPeer.mean))} MB`).join(', ')
  return `<li><b>${esc(g.group)}</b>: ${esc(weakName)} peers (CPU x${throttleOf(weakName) ?? '?'}) uploaded ${fmtAgg(w.uploadBytes, 1, 1e-6)} MB per run, ` +
    `${fmtAgg(w.uploadShare, 0, 100)} % of all P2P upload. Per peer: ${esc(weakName)} ${fmt(MB(w.uploadPerPeer.mean))} MB vs ${others}.</li>`
}).join('')

const title = groups.length === 2 ? `${groups[0].group} vs ${groups[1].group}` : groups[0].group
const outFile = path.join(outDir, groups.map((g) => g.group).join('-vs-') + '.html')

const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>P2P report: ${esc(title)}</title>
<style>
  :root { color-scheme: light dark; --bg:#ffffff; --fg:#1f2328; --muted:#59636e; --grid:rgba(0,0,0,.1); --card:#f6f8fa; --border:#d0d7de; --bad:#cf222e; --bad-bg:#ffebe9; --ok-bg:#dafbe1; --hl:#fff8c5; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --fg:#e6edf3; --muted:#9198a1; --grid:rgba(255,255,255,.12); --card:#161b22; --border:#30363d; --bad:#ff7b72; --bad-bg:#3c1618; --ok-bg:#12261e; --hl:#3a2f00; } }
  body { font-family: system-ui, sans-serif; margin: 24px auto; max-width: 1200px; padding: 0 16px; background: var(--bg); color: var(--fg); }
  h1 { margin-bottom: 4px } .sub { color: var(--muted); margin-top: 0 }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(520px, 1fr)); gap: 16px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px; }
  .card canvas { width: 100% !important; height: 340px !important; }
  .note { color: var(--muted); font-size: 13px; margin: 6px 0 0; }
  table { border-collapse: collapse; margin: 8px 0 20px; font-size: 14px; }
  th, td { border: 1px solid var(--border); padding: 4px 8px; text-align: left; vertical-align: top; }
  th { background: var(--card); }
  .rng { color: var(--muted); font-size: 12px; }
  tr.weak td { background: var(--hl); } tr.bad td { color: var(--bad); }
  .issues { border: 1px solid var(--bad); background: var(--bad-bg); border-radius: 8px; padding: 4px 16px; margin: 16px 0; }
  .issues h2 { color: var(--bad); font-size: 18px; }
  .ok { border: 1px solid var(--border); background: var(--ok-bg); border-radius: 8px; padding: 10px 16px; margin: 16px 0; }
  .callout { border-left: 4px solid ${COLORS[1]}; padding: 4px 12px; margin-top: 8px; }
  #nochart { display: none; color: var(--bad); }
  code { font-size: 12px; }
</style>
<script src="${CHART_JS}"></script>
</head><body>
<h1>P2P streaming report: ${esc(title)}</h1>
<p class="sub">${groups.map((g) => esc(label(g))).join(' &nbsp;|&nbsp; ')} &nbsp;·&nbsp; generated ${esc(new Date().toISOString())}</p>
<p id="nochart">Chart.js could not be loaded from cdnjs (offline?). The tables below are still complete.</p>
${issuesHtml}

<div class="grid">
  <div class="card"><canvas id="cQuality"></canvas><p class="note">Mean playing height across peers in each ${BUCKET_SEC} s window of the run (time since run start). Line = mean across runs, shaded band = min–max across runs. Height 0 and rows after playTime ≥ ${END_PLAYTIME} s are excluded.</p></div>
  <div class="card"><canvas id="cStall"></canvas><p class="note">Total stall seconds of all peers of each profile in one run. Bar = mean across runs, whisker = min–max.</p></div>
  <div class="card"><canvas id="cCdn"></canvas><p class="note">Bytes the CDN server sent per run (last servedBytes in the server log). One bar per run.</p></div>
  <div class="card"><canvas id="cUpload"></canvas><p class="note">Total P2P bytes uploaded by peers of each profile in one run. Bar = mean across runs, whisker = min–max. The ${esc(weakName)} profile has a heavy outline.</p>
    <ul class="callout">${weakCallout}</ul></div>
</div>

<h2>Config used</h2>
<table><tr><th></th>${groups.map((g) => `<th>${esc(g.group)}</th>`).join('')}</tr>${configRows}</table>
${sameCode ? `<p class="note">Code identical between groups: run.mjs ${sameCode[0] ? 'yes' : '<b>NO</b>'}, index.html ${sameCode[1] ? 'yes' : '<b>NO</b>'}, server.mjs ${sameCode[2] ? 'yes' : '<b>NO</b>'}.</p>` : ''}

<h2>Per profile <span class="rng">(mean [min–max] across runs)</span></h2>
${profileTable}
<h2>Seconds at each quality, per peer <span class="rng">(mean [min–max] across runs)</span></h2>
${qualitySecondsTable}
<h2>Totals per run <span class="rng">(mean [min–max] across runs)</span></h2>
${totalsTable}
<h2>Runs</h2>
${runsTable}
<h2>Method</h2>
<ul class="note">
  <li>All byte and stall fields are cumulative, so per-peer values come from each peer's last report.</li>
  <li>Quality time and seconds-at-quality exclude rows with height 0 and rows with playTime ≥ ${END_PLAYTIME} s (pages keep reporting after the clip ends). Each report is counted as 1 s.</li>
  <li>Stall seconds include stalls of peers that never reached the end of the clip; such peers are listed above.</li>
  <li>The peers field of the reports is not used.</li>
  <li>Ranges are min–max across runs; with 1 run they collapse to the single value.</li>
</ul>

<script>
const D = ${JSON.stringify(chartData).replace(/</g, '\\u003c')};
if (!window.Chart) { document.getElementById('nochart').style.display = 'block' } else {
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => location.reload());
  const css = getComputedStyle(document.documentElement);
  const fg = css.getPropertyValue('--fg').trim(), grid = css.getPropertyValue('--grid').trim();
  Chart.defaults.color = fg;
  Chart.defaults.borderColor = grid;
  Chart.defaults.font.family = 'system-ui, sans-serif';
  const alpha = (hex, a) => hex + Math.round(a * 255).toString(16).padStart(2, '0');
  const sub = D.groups.map((g) => g.label).join('   |   ');
  const titles = (text) => ({ title: { display: true, text, font: { size: 15 } }, subtitle: { display: true, text: sub, padding: { bottom: 8 } } });
  const f1 = (x) => x == null ? '–' : x.toFixed(1);
  const rangeMax = (key) => Math.max(0, ...D.groups.flatMap((g) => g[key].map((a) => a?.max ?? 0))) * 1.05;

  const errorBars = {
    id: 'errorBars',
    afterDatasetsDraw(chart) {
      const { ctx, scales: { y } } = chart;
      chart.data.datasets.forEach((ds, i) => {
        const meta = chart.getDatasetMeta(i);
        if (!ds.ranges || meta.hidden) return;
        meta.data.forEach((bar, j) => {
          const r = ds.ranges[j];
          if (!r || r.min == null) return;
          const top = y.getPixelForValue(r.max), bot = y.getPixelForValue(r.min), w = Math.min(8, bar.width / 3);
          ctx.save(); ctx.strokeStyle = fg; ctx.lineWidth = 1.5; ctx.beginPath();
          ctx.moveTo(bar.x, top); ctx.lineTo(bar.x, bot);
          ctx.moveTo(bar.x - w, top); ctx.lineTo(bar.x + w, top);
          ctx.moveTo(bar.x - w, bot); ctx.lineTo(bar.x + w, bot);
          ctx.stroke(); ctx.restore();
        });
      });
    }
  };
  const rangeTooltip = { callbacks: { label: (c) => {
    const r = c.dataset.ranges?.[c.dataIndex];
    return c.dataset.label + ': ' + f1(c.parsed.y) + (r ? '  [' + f1(r.min) + '–' + f1(r.max) + ']' : '');
  } } };

  // (a) quality over time
  new Chart(document.getElementById('cQuality'), {
    type: 'line',
    data: { datasets: D.groups.flatMap((g) => [
      { label: g.name + ' min', data: g.quality.map((q) => ({ x: q.x, y: q.min })), borderWidth: 0, pointRadius: 0, fill: false, isRange: true },
      { label: g.name + ' range (min–max)', data: g.quality.map((q) => ({ x: q.x, y: q.max })), borderWidth: 0, pointRadius: 0, fill: '-1', backgroundColor: alpha(g.color, 0.2) },
      { label: g.name + ' mean', data: g.quality.map((q) => ({ x: q.x, y: q.mean })), borderColor: g.color, backgroundColor: g.color, pointRadius: 2, borderWidth: 2, tension: 0.2 }
    ]) },
    options: {
      maintainAspectRatio: false, parsing: true, interaction: { mode: 'nearest', intersect: false },
      scales: { x: { type: 'linear', title: { display: true, text: 'seconds since run start' } },
                y: { suggestedMin: 0, title: { display: true, text: 'mean height (p)' } } },
      plugins: { ...titles('(a) Mean quality over time'), legend: { labels: { filter: (l, d) => !d.datasets[l.datasetIndex].isRange } },
        tooltip: { filter: (item) => !item.dataset.isRange } }
    }
  });

  // (b) stall seconds per profile
  new Chart(document.getElementById('cStall'), {
    type: 'bar',
    data: { labels: D.profiles, datasets: D.groups.map((g) => ({
      label: g.name, data: g.stallSec.map((a) => a?.mean ?? null), ranges: g.stallSec,
      backgroundColor: alpha(g.color, 0.75), borderColor: g.color, borderWidth: 1 })) },
    options: { maintainAspectRatio: false, scales: { y: { beginAtZero: true, suggestedMax: rangeMax('stallSec'), title: { display: true, text: 'stall seconds per run (all peers of profile)' } } },
      plugins: { ...titles('(b) Stall seconds per profile'), tooltip: rangeTooltip } },
    plugins: [errorBars]
  });

  // (c) CDN bytes per run
  const runLabels = Array.from({ length: D.maxRuns }, (_, i) => 'r' + (i + 1));
  new Chart(document.getElementById('cCdn'), {
    type: 'bar',
    data: { labels: runLabels, datasets: D.groups.map((g) => ({
      label: g.name, data: runLabels.map((r) => g.cdnPerRun.find((x) => x.run === r)?.mb ?? null),
      backgroundColor: alpha(g.color, 0.75), borderColor: g.color, borderWidth: 1 })) },
    options: { maintainAspectRatio: false, scales: { y: { beginAtZero: true, title: { display: true, text: 'MB served by CDN' } } },
      plugins: { ...titles('(c) Total CDN bytes per run'), subtitle: { display: true, padding: { bottom: 8 }, text: D.groups.map((g) => {
        const v = g.cdnPerRun.map((x) => x.mb).filter((x) => x != null);
        const m = v.reduce((s, x) => s + x, 0) / (v.length || 1);
        return g.label + ': mean ' + f1(m) + ' MB [' + f1(Math.min(...v)) + '–' + f1(Math.max(...v)) + ']';
      }).join('   |   ') } } }
  });

  // (d) upload bytes per profile
  new Chart(document.getElementById('cUpload'), {
    type: 'bar',
    data: { labels: D.profiles.map((p) => p === D.weak ? p + ' ◀' : p), datasets: D.groups.map((g) => ({
      label: g.name, data: g.upload.map((a) => a?.mean ?? null), ranges: g.upload,
      backgroundColor: alpha(g.color, 0.75), borderColor: D.profiles.map((p) => p === D.weak ? fg : g.color),
      borderWidth: D.profiles.map((p) => p === D.weak ? 3 : 1) })) },
    options: { maintainAspectRatio: false, scales: { y: { beginAtZero: true, suggestedMax: rangeMax('upload'), title: { display: true, text: 'MB uploaded per run (all peers of profile)' } } },
      plugins: { ...titles('(d) Upload bytes per profile'), tooltip: rangeTooltip } },
    plugins: [errorBars]
  });
}
</script>
</body></html>
`
fs.writeFileSync(outFile, html)

// ---- console summary ----
for (const g of groups) {
  console.log(`\n${label(g)}`)
  console.table(Object.fromEntries(g.profiles.map((p) => {
    const a = g.A.profiles[p]
    const n = a.peers.mean
    return [p, {
      peers: +fmt(n, 0),
      stallsPerPeer: +fmt(a.stalls.mean / n, 2), stallSecPerPeer: +fmt(a.stallSec.mean / n),
      stalledPct: +fmt(a.stalledShare.mean * 100, 0), startupMs: +fmt(a.meanStartupMs.mean, 0),
      uploadMBPerPeer: +fmt(MB(a.uploadPerPeer.mean))
    }]
  })))
  console.log(`CDN per run: ${fmt(MB(g.A.totals.cdnServer.mean))} MB [${fmt(MB(g.A.totals.cdnServer.min))}–${fmt(MB(g.A.totals.cdnServer.max))}]`)
  const n = g.groupIssues.length + sum(g.runs.map((r) => r.issues.length))
  if (n) {
    console.log(`${n} issue(s):`)
    for (const s of g.groupIssues) console.log('  ' + s)
    for (const r of g.runs) for (const s of r.issues) console.log(`  ${r.name}: ${s}`)
  }
}
console.log('\nwrote:\n  ' + [...written, path.relative(path.join(here, '..'), outFile)].join('\n  '))
