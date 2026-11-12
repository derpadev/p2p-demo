# P2P video streaming demo

Local lab that compares P2P peer selection strategies (baseline now, hardware-aware later) using headless Chrome peers with throttled CPUs.

All commands are for Windows CMD, run from this folder (the one with `package.json`).

## 1. One-time setup

```
npm install
```

Google Chrome must be installed (the launcher uses it through Playwright's `channel: 'chrome'`).

## 2. Start the tracker and the CDN server (two separate CMD windows, leave them open)

```
node tracker.mjs
```

```
node server.mjs 4
```

The number is the total CDN cap in Mbit/s shared by all segment downloads (`0` = unlimited). It can also be changed later without a restart:

```
curl "http://localhost:8080/__cap?mbps=4"
curl "http://localhost:8080/__stats"
```

## Dashboard: P2P vs CDN only

With the tracker and the CDN server running, open http://localhost:8080/dashboard in Chrome. Pick a mode (CDN only, with P2P, or both back to back), set the CDN cap, and press Start. Each run uses the same launcher settings as the batches (10 peers, one every 5 s, same CPU profiles) and takes about 4 minutes. The page shows the CDN sending rate, every peer's quality, freezes and download split live, and compares the latest CDN-only and P2P runs. Demo runs are saved in `results\` as `demo-<time>-<mode>`.

For a proper CDN-only group to compare with `analyze.mjs`, add `--no-p2p` to a batch:

```
node launcher\batch.mjs cdnonly --runs 5 --peers 10 --interval 5 --cap 4 --no-p2p
node analysis\analyze.mjs cdnonly baseline2
```

## 3. Smoke test (one run)

```
node launcher\run.mjs smoke1 --peers 4 --interval 5
```

Add `--headed` to watch the browser windows. Output: `results\smoke1.jsonl` and `results\smoke1.server.jsonl`.

## 4. Batch of runs (one group)

```
node launcher\batch.mjs <group> [--runs 5] [--peers N] [--interval SEC] [--cap MBPS] [--gap SEC] [--overwrite]
```

- Runs the same scenario `--runs` times as `<group>-r1`, `<group>-r2`, ... (one call of `launcher\run.mjs` each).
- `--cap` sets the server cap through `/__cap` first; without it the server's current cap is used.
- `--gap` is the pause between runs (default 10 s).
- Refuses to start if results for `<group>` already exist; `--overwrite` deletes only that group's files first.
- Writes `results\<group>.config.json` (settings, peer mix, profiles, clip length, library versions, code hashes, and the status and problems of every run) and `results\<group>.batch.log` (full launcher output).
- Exits with code 1 if a run crashed. Runs with missing peers or peers that did not finish are kept and flagged.

Acceptance example:

```
node launcher\batch.mjs test --runs 2 --peers 4 --interval 5
```

Typical comparison workflow (pick peers and cap after calibration; keep them the same for both groups):

```
node launcher\batch.mjs baseline --runs 5 --peers 10 --interval 5 --cap 4
rem ...switch the code to the hardware-aware version...
node launcher\batch.mjs hwaware --runs 5 --peers 10 --interval 5 --cap 4
```

## 5. Analysis and report

```
node analysis\analyze.mjs <groupA> [groupB]
```

Examples:

```
node analysis\analyze.mjs test
node analysis\analyze.mjs baseline hwaware
```

Writes to `results\summary\`:

- `<group>_runs.csv`: per run status, CDN bytes, P2P down/up, stall seconds, problems
- `<group>_profiles.csv`: per run and profile, plus mean/min/max rows: stalls, stall seconds, share of peers that stalled, mean startup, upload bytes
- `<group>_quality_over_time.csv`: mean height per 5 s window, per run plus mean/min/max
- `<group>_quality_seconds.csv`: seconds per peer at each quality, per profile
- `<groupA>.html` or `<groupA>-vs-<groupB>.html`: report with four charts and the config tables. Open it in Chrome (charts need internet access to load Chart.js 4.4.1 from cdnjs).

```
start results\summary\test.html
```
