// Leak + concurrency stress: does the daemon give back what it takes?
//
// A verification layer that leaks is worse than no verification layer, because it degrades the very
// process it is supposed to be telling the truth about — and it degrades it slowly, so the first
// symptom is a flaky verdict rather than an error. Nothing in this repo has ever measured it.
//
// Three axes, because they fail differently and independently:
//   MEMORY  — daemon RSS across N sequential sessions. A per-session structure never released shows
//             up as monotonic growth; GC noise shows up as a sawtooth. We report both endpoints and
//             the slope so the difference is visible rather than asserted.
//   PORTS   — listening sockets before vs after. The daemon binds a bridge port per instance; a
//             session that dies without closing leaves it bound, and the next run silently attaches
//             to the survivor. That exact failure has already cost this project two invalid
//             benchmark runs, so it is measured, not assumed.
//   THREADS/HANDLES — child processes and open handles. Parallel agents are the default workflow now
//             (playwright-mcp#893 is open on precisely this), so the concurrent path is the one that
//             matters, not the sequential one.
//
// Deliberately NOT a unit test: it needs a real daemon, a real browser and wall-clock time, so it
// lives with the benchmarks and is run on demand.
//
//   node bench/harness/leak-stress.mjs [sessions] [concurrency]
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { McpStdioClient, RETICLE_CLI as CLI } from './mcp-client.mjs';
import { RETICLE_PORT } from './ports.mjs';

const SESSIONS = Number(process.argv[2] ?? 12);
const CONCURRENCY = Number(process.argv[3] ?? 4);
const APP = process.env.BENCH_URL ?? 'http://localhost:4312/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Listening TCP ports owned by this user — the population a leak would add to. */
function listeningPorts() {
  try {
    const out = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' });
    return new Set(
      out
        .split('\n')
        .slice(1)
        .map((line) => line.match(/:(\d+)\s+\(LISTEN\)/)?.[1])
        .filter((p) => p !== undefined),
    );
  } catch {
    return new Set();
  }
}

/** RSS in MB for a pid, via ps. Returns null if the process is gone. */
function rssMb(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return out.length > 0 ? Math.round(Number(out) / 1024) : null;
  } catch {
    return null;
  }
}

/** Descendant process count — catches leaked browsers/daemons that outlive their client. */
function descendants(pid) {
  try {
    const out = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).trim();
    return out.length > 0 ? out.split('\n').length : 0;
  } catch {
    return 0;
  }
}

/** One full session lifecycle against a shared daemon: connect, drive, read, end. */
async function exerciseSession(client, index) {
  const sessions = (await client.callTool('reticle_sessions', {})).text;
  let sid;
  try {
    sid = JSON.parse(sessions)?.sessions?.[0]?.sessionId;
  } catch {
    sid = undefined;
  }
  if (sid === undefined) return { index, ok: false, reason: 'no session' };
  // A representative mix: a DOM read, a state read, and an observe — the three payload shapes.
  await client.callTool('reticle_query', { sessionId: sid, by: 'testid', value: 'brand' });
  await client.callTool('reticle_state', { sessionId: sid, store: 'app', path: 'view' });
  await client.callTool('reticle_observe', { sessionId: sid, filters: ['net'], since: 0 });
  return { index, ok: true };
}

const portsBefore = listeningPorts();

// Must be the port the fixture's SDK dials, fixed when its dev server started (bench-app defaults to
// 4460). A daemon listening anywhere else gets no browser session at all and every measurement below
// silently becomes a measurement of an idle daemon — which is exactly how the whole bench/harness
// fleet ran against nothing for an unknown number of commits.
const PORT = RETICLE_PORT;
const client = new McpStdioClient('node', [CLI, 'mcp', '--port', PORT, '--drive', APP], {
  RETICLE_PORT: PORT,
  RETICLE_ADVERTISE_ALL_TOOLS: '1',
});
await client.start();
await sleep(4000); // driven browser + SDK handshake

const daemonPid = client.proc?.pid;
{
  // Refuse to measure an unattached daemon. A leak report over a daemon with no app is all zeros —
  // indistinguishable from a perfect result, which is the worst possible failure for this harness.
  const probe = JSON.parse((await client.callTool('reticle_sessions', {})).text ?? '{}');
  if (0 === (probe.sessions ?? []).length) {
    throw new Error(
      `no browser session on :${PORT} — the fixture's SDK dials a different port, so this would ` +
        'measure an idle daemon and report zeros as if they were clean.',
    );
  }
}
const samples = [];
const rssStart = rssMb(daemonPid);

// ---- sequential phase: does repeated use grow the daemon monotonically? ----
const sequentialResults = [];
for (let i = 0; i < SESSIONS; i++) {
  sequentialResults.push(await exerciseSession(client, i));
  samples.push({
    phase: 'sequential',
    i,
    rss_mb: rssMb(daemonPid),
    children: descendants(daemonPid),
  });
}
const rssAfterSequential = rssMb(daemonPid);

// ---- concurrent phase: parallel agents against one daemon (playwright-mcp#893's failure) ----
const concurrentResults = [];
for (let wave = 0; wave < Math.ceil(SESSIONS / CONCURRENCY); wave++) {
  const batch = Array.from({ length: CONCURRENCY }, (_, k) =>
    exerciseSession(client, wave * CONCURRENCY + k).catch((e) => ({
      ok: false,
      reason: String(e).slice(0, 120),
    })),
  );
  concurrentResults.push(...(await Promise.all(batch)));
  samples.push({
    phase: 'concurrent',
    i: wave,
    rss_mb: rssMb(daemonPid),
    children: descendants(daemonPid),
  });
}
const rssAfterConcurrent = rssMb(daemonPid);

await client.stop();
await sleep(2500); // give the daemon a chance to release sockets/children

const portsAfter = listeningPorts();
const newPorts = [...portsAfter].filter((p) => !portsBefore.has(p));
const survivingChildren = descendants(daemonPid);

// The daemon's own port is NOT a leak, and calling it one would make this harness a false-positive
// generator — the exact failure it exists to catch.
//
// `reticle mcp` spawns the daemon DETACHED and unref'd on purpose, so it outlives any single client
// and several agents share one browser. What bounds it is the idle watcher: 300s of continuous idle
// (no agent, no session, no lease), re-checked every 30s, then self-exit. So the honest distinction
// is "persists by design, bounded" versus "retained with nothing to release it". Anything OTHER than
// the daemon port surviving would be the real leak.
const leakedPorts = newPorts.filter((p) => p !== PORT);

// Growth per session over the sequential phase. The endpoint slope ALONE cannot distinguish a leak
// (sustained per-session growth) from a one-time allocation step (V8 heap resize / pool warm-up)
// followed by a plateau: a measured run went 48→50 flat for six sessions, stepped 38 MB once at
// session 7, then sat flat through five more sequential + sixteen concurrent sessions — and the
// endpoint slope reported that as "3.6 MB/session", a false leak signal from the leak harness
// itself. So the per-sample deltas classify the SHAPE, and only sustained growth reads as a leak.
const seq = samples.filter((s) => 'sequential' === s.phase && 'number' === typeof s.rss_mb);
const slopeMbPerSession =
  seq.length > 1 && seq[0] !== undefined && seq.at(-1) !== undefined
    ? Number(((seq.at(-1).rss_mb - seq[0].rss_mb) / (seq.length - 1)).toFixed(3))
    : null;
// A delta ≤ 2 MB is measurement noise (ps rounds to MB; GC jitters). More than two growth steps, or
// a tail still climbing, is the leak signature; one or two steps with a flat tail is an allocation.
const NOISE_MB = 2;
const deltas = seq.slice(1).map((s, i) => s.rss_mb - seq[i].rss_mb);
const growthSteps = deltas.filter((d) => d > NOISE_MB).length;
const tailFlat = deltas.slice(-3).every((d) => d <= NOISE_MB);
const growthShape =
  0 === growthSteps
    ? 'flat'
    : growthSteps <= 2 && tailFlat
      ? 'step-then-plateau'
      : 'sustained-growth';

const report = {
  metric: 'daemon memory / port / child-process retention under sequential and concurrent load',
  config: { sessions: SESSIONS, concurrency: CONCURRENCY, app: APP },
  memory: {
    rss_start_mb: rssStart,
    rss_after_sequential_mb: rssAfterSequential,
    rss_after_concurrent_mb: rssAfterConcurrent,
    slope_mb_per_session: slopeMbPerSession,
    growth_shape: growthShape,
    // The verdict a reader should trust: shape-based, immune to a one-time step inflating the slope.
    leak_suspected: 'sustained-growth' === growthShape,
  },
  ports: {
    daemon_port_still_listening: newPorts.includes(PORT),
    daemon_persistence: 'by design — detached + unref, bounded by a 300s idle self-shutdown',
    leaked: leakedPorts,
    // A leaked LISTEN socket is the failure that silently attaches the NEXT run to a survivor, so it
    // is reported as a hard boolean rather than left for a reader to infer from two set sizes.
    leaked_any: leakedPorts.length > 0,
  },
  processes: { surviving_children_after_stop: survivingChildren },
  sequential: {
    total: sequentialResults.length,
    ok: sequentialResults.filter((r) => r.ok).length,
    failures: sequentialResults.filter((r) => !r.ok).slice(0, 3),
  },
  concurrent: {
    total: concurrentResults.length,
    ok: concurrentResults.filter((r) => r.ok).length,
    failures: concurrentResults.filter((r) => !r.ok).slice(0, 5),
  },
  samples,
};
writeFileSync('bench/raw/leak-stress.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, samples: `${samples.length} samples` }, null, 2));
process.exit(0);
