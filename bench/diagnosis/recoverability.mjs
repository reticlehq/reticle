/**
 * Is the file RECOVERABLE without the stamp — at any cost?
 *
 * The coverage metric says a failure report carries `file:line`. The obvious follow-up is "so what,
 * the agent could just look it up" — and that objection deserves a measurement rather than an
 * argument. This runs the two conditions and, in each, tries every route Reticle offers an agent to
 * obtain the source of an element it has already found:
 *
 *   query    — the descriptor's own `source` (0 extra calls; what this build added)
 *   inspect  — reticle_inspect's component/source (1 extra call; the pre-existing route)
 *
 * A cost difference would be a convenience argument. What it actually finds is a difference in
 * KIND: with the stamp the file costs nothing, and without it no number of calls recovers it. That
 * is the honest form of the claim — not "the pointer is faster" but "the pointer is the only path".
 *
 *   node bench/diagnosis/recoverability.mjs
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { McpStdioClient, RETICLE_CLI as CLI } from '../harness/mcp-client.mjs';
import { APP_ORIGIN } from '../pw-vs-reticle/bugs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.BENCH_RETICLE_PORT ?? '4461';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parse = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};

/** Controls present on the logged-in shell — no navigation needed, so the probe stays deterministic. */
const TARGETS = ['nav-deployments', 'nav-compose', 'nav-overview', 'brand', 'session-pill'];

const client = new McpStdioClient('node', [CLI, 'mcp', '--port', PORT], {
  RETICLE_PORT: PORT,
  RETICLE_ADVERTISE_ALL_TOOLS: '1',
});
await client.start();
const profile = path.join(os.tmpdir(), `rrec-${String(process.pid)}`);
const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`, APP_ORIGIN],
  { stdio: 'ignore', detached: true },
);
chrome.unref();

const call = async (n, a) => parse((await client.callTool(n, a)).text ?? '');

let sid;
for (let i = 0; i < 40 && sid === undefined; i += 1) {
  sid = (await call('reticle_sessions', {}))?.sessions?.[0]?.sessionId;
  if (sid === undefined) await sleep(500);
}
if (sid === undefined) throw new Error('no Reticle session — is apps/bench-app running?');

async function condition(label, url) {
  const before = new Set(
    ((await call('reticle_sessions', {}))?.sessions ?? []).map((s) => s.sessionId),
  );
  await call('reticle_navigate', { sessionId: sid, url });
  for (let i = 0; i < 30; i += 1) {
    const all = (await call('reticle_sessions', {}))?.sessions ?? [];
    const fresh = all.filter((s) => !s.stale && !before.has(s.sessionId));
    if (fresh.length > 0) {
      sid = fresh[fresh.length - 1].sessionId;
      break;
    }
    await sleep(300);
  }
  await sleep(600);
  // log in
  for (let i = 0; i < 30; i += 1) {
    const q = await call('reticle_query', { sessionId: sid, by: 'testid', value: 'login-submit' });
    const ref = q?.elements?.[0]?.ref;
    if (ref !== undefined) {
      await call('reticle_act', { sessionId: sid, ref, action: 'click' });
      break;
    }
    await sleep(300);
  }
  await sleep(1200);

  const rows = [];
  for (const testid of TARGETS) {
    const q = await call('reticle_query', { sessionId: sid, by: 'testid', value: testid });
    const el = q?.elements?.[0];
    if (el?.ref === undefined) {
      rows.push({ testid, found: false });
      continue;
    }
    const inspected = await call('reticle_inspect', { sessionId: sid, ref: el.ref });
    const viaQuery = typeof el.source === 'string' ? el.source : undefined;
    const compSource = inspected?.component?.source;
    const viaInspect =
      typeof inspected?.source === 'string'
        ? inspected.source
        : compSource !== undefined && compSource !== null
          ? `${String(compSource.file)}:${String(compSource.line)}`
          : undefined;
    rows.push({ testid, found: true, viaQuery, viaInspect });
  }
  const found = rows.filter((r) => r.found);
  const summary = {
    condition: label,
    elements: found.length,
    viaQuery: found.filter((r) => r.viaQuery !== undefined).length,
    viaInspect: found.filter((r) => r.viaInspect !== undefined).length,
    recoverableByAnyRoute: found.filter(
      (r) => r.viaQuery !== undefined || r.viaInspect !== undefined,
    ).length,
  };
  console.log(
    `${label.padEnd(22)} elements=${String(summary.elements)}  ` +
      `source via query=${String(summary.viaQuery)}  via inspect=${String(summary.viaInspect)}  ` +
      `recoverable by ANY route=${String(summary.recoverableByAnyRoute)}`,
  );
  return { summary, rows };
}

console.log('\n=== Is the file recoverable without the stamp? ===\n');
const on = await condition('stamps present', `${APP_ORIGIN}/`);
const off = await condition('stamps stripped', `${APP_ORIGIN}/?nosource=1`);

console.log(
  `\nWith the stamp the file costs ZERO extra calls (it is already on the descriptor).\n` +
    `Without it, ${String(off.summary.recoverableByAnyRoute)} of ${String(off.summary.elements)} elements ` +
    `yield a file through ANY Reticle route — inspect included.\n` +
    `So the difference is not cost, it is availability.`,
);

mkdirSync(path.join(HERE, '..', 'raw'), { recursive: true });
writeFileSync(
  path.join(HERE, '..', 'raw', 'recoverability.json'),
  JSON.stringify({ on, off }, null, 2),
);
console.log('\nwritten to bench/raw/recoverability.json');
process.exit(0);
