// Multi-agent throughput (Q1/Q5): the BrowserPool's payoff. One real Chromium, N isolated leased
// contexts. Each "flow" = acquire(url) [real context create + navigation] + a hold representing the
// verify steps + release. We compare SERIAL (cap=1) vs POOLED-PARALLEL (cap=N) wall-clock over M flows
// so the speedup and peak concurrency are measured, not asserted. Needs the demo at BENCH_URL.
import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { BrowserPool, playwrightLauncher } from '@reticlehq/server';

const URL = process.env.BENCH_URL ?? 'http://localhost:4312/';
const M = Number(process.env.FLOWS ?? 16); // total flows to run through the pool
const N = Number(process.env.MAX ?? Math.min(16, cpus().length - 2)); // pooled cap
const HOLD = Number(process.env.HOLD_MS ?? 1800); // per-flow verify work (≈ a real flow replay)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let counter = 0;
const genSessionId = () => `mab-${counter++}`;

async function runFlow(pool, peak) {
  const lease = await pool.acquire(URL);
  peak.cur += 1;
  peak.max = Math.max(peak.max, peak.cur);
  await sleep(HOLD); // stand-in for the flow's verify steps (deterministic, no LLM)
  peak.cur -= 1;
  await lease.release();
}

async function measure(maxContexts) {
  const pool = new BrowserPool(playwrightLauncher({ headless: true }), {
    maxContexts,
    genSessionId,
  });
  const peak = { cur: 0, max: 0 };
  const t0 = Date.now();
  await Promise.all(Array.from({ length: M }, () => runFlow(pool, peak)));
  const ms = Date.now() - t0;
  await pool.shutdown();
  return { ms, peak: peak.max };
}

console.log(`multi-agent throughput: ${M} flows, serial(cap1) vs pooled(cap${N}), hold=${HOLD}ms`);
const serial = await measure(1);
const parallel = await measure(N);
const result = {
  metric: 'multi-agent flow throughput — one Chromium, N isolated leased contexts',
  url: URL,
  flows: M,
  pool_cap: N,
  per_flow_hold_ms: HOLD,
  serial_ms: serial.ms,
  pooled_ms: parallel.ms,
  speedup: +(serial.ms / parallel.ms).toFixed(2),
  peak_concurrency: parallel.peak,
  pooled_throughput_flows_per_sec: +(M / (parallel.ms / 1000)).toFixed(2),
  wall_clock_saved_ms: serial.ms - parallel.ms,
  note: 'Serial = one context at a time (what a single-browser agent does). Pooled = up to cap concurrent leased contexts from ONE browser. Speedup is the multi-agent time saving; peak_concurrency confirms real parallelism.',
};
console.log(JSON.stringify(result, null, 2));
writeFileSync('bench/raw/multi-agent-throughput.json', JSON.stringify(result, null, 2));
