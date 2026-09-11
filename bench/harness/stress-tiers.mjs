// Does Reticle stay usable as the app gets big? Three tiers, one harness.
//
// Every published Reticle number is scoped to a 34-file fixture. That scope is the single largest
// caveat on the whole benchmark suite, and "it works on the demo app" is exactly the claim a buyer
// discounts. `apps/large-dom-bench` takes `?rows=N`, so the tiers are the same app at three sizes —
// which is the right control: the code under test is identical, only the scale moves, so a
// regression at 20k rows cannot be blamed on a different app.
//
//   normal  ~800 rows    a real dashboard page
//   medium  ~5,000 rows  a table nobody paginated
//   hard    ~20,000 rows the page that should have been virtualised
//
// Measures, per tier, the three payload shapes an agent actually uses (a scoped query, a broad query,
// a state read, an observe) plus daemon RSS. The interesting number is not absolute latency — that is
// a property of this laptop — but how each cost SCALES. A query whose cost is linear in total DOM
// rather than in match count is a different product at 20k rows than at 800, and that is the kind of
// thing this catches and a fixture never will.
//
//   node bench/harness/stress-tiers.mjs [appUrl]
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { McpStdioClient, RETICLE_CLI as CLI } from './mcp-client.mjs';
import { measure } from './tokenizer.mjs';
import { RETICLE_PORT } from './ports.mjs';

const APP = process.argv[2] ?? process.env.STRESS_URL ?? 'http://localhost:4313/';
const TIERS = [
  { name: 'normal', rows: 800 },
  { name: 'medium', rows: 5000 },
  { name: 'hard', rows: 20000 },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rssMb(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return out.length > 0 ? Math.round(Number(out) / 1024) : null;
  } catch {
    return null;
  }
}

/** Time a tool call and report what the agent would actually pay to read it. */
async function timed(client, tool, args) {
  const t0 = Date.now();
  let text = '';
  let error;
  try {
    ({ text } = await client.callTool(tool, args));
  } catch (e) {
    error = String(e).slice(0, 160);
  }
  const ms = Date.now() - t0;
  const m = measure(text ?? '');
  return { tool, ms, bytes: m.bytes, tokens: m.tokens_o200k, ...(error ? { error } : {}) };
}

const results = [];
for (const tier of TIERS) {
  // The fixture's SDK dials RETICLE_PORT, baked in when ITS dev server started — large-dom-bench
  // comes from ports.mjs, the one place that owns it. A daemon on any other port gets no session at all, and the
  // whole report becomes a measurement of an idle daemon. Tiers run sequentially and each stops
  // before the next starts, so one port suffices.
  const port = RETICLE_PORT;
  const url = `${APP}${APP.includes('?') ? '&' : '?'}rows=${tier.rows}`;
  const client = new McpStdioClient('node', [CLI, 'mcp', '--port', port, '--drive', url], {
    RETICLE_PORT: port,
    RETICLE_ADVERTISE_ALL_TOOLS: '1',
  });
  await client.start();
  await sleep(5000); // large DOM needs longer to render + connect than the small fixture

  let sid;
  try {
    sid = JSON.parse((await client.callTool('reticle_sessions', {})).text)?.sessions?.[0]
      ?.sessionId;
  } catch {
    sid = undefined;
  }

  if (sid === undefined) {
    // Loud, not a quiet error row: "no session" is a HARNESS misconfiguration (wrong port), and
    // recording it beside real measurements invites reading it as a product limit at scale.
    await client.stop();
    throw new Error(
      `no browser session on :${port} for ${tier.name} — the fixture's SDK dials a different port, ` +
        'so this would measure an idle daemon rather than the app.',
    );
  }

  const calls = [
    // Scoped query: should be ~flat in page size. If it is not, cost is linear in total DOM.
    await timed(client, 'reticle_query', { sessionId: sid, by: 'testid', value: 'approvals-grid' }),
    // Broad query: the honest worst case — thousands of matches.
    await timed(client, 'reticle_query', { sessionId: sid, by: 'role', value: 'row' }),
    // count_only: the escape hatch. Should stay tiny no matter the match count.
    await timed(client, 'reticle_query', {
      sessionId: sid,
      by: 'role',
      value: 'row',
      count_only: true,
    }),
    // Scoped state read against a store holding every row.
    await timed(client, 'reticle_state', { sessionId: sid, store: 'app', path: 'rows.0' }),
    // Whole-store read: the path with the known silent-truncation defect.
    await timed(client, 'reticle_state', { sessionId: sid, store: 'app', depth: 1 }),
    await timed(client, 'reticle_observe', { sessionId: sid, filters: ['net'], since: 0 }),
    await timed(client, 'reticle_snapshot', { sessionId: sid }),
  ];

  results.push({
    tier: tier.name,
    rows: tier.rows,
    daemon_rss_mb: rssMb(client.proc?.pid),
    calls,
    total_tokens_to_drive: calls.reduce((a, c) => a + c.tokens, 0),
    slowest_ms: Math.max(...calls.map((c) => c.ms)),
  });
  console.log(`${tier.name} (${tier.rows} rows):`, JSON.stringify(results.at(-1)?.calls));
  await client.stop();
  await sleep(1500);
}

// Scaling factor per call, normal -> hard. This is the number that decides whether the fixture-scoped
// claims generalise: ~1x means the cost is bounded by the transport, ~25x means it tracks the DOM.
const scaling = {};
const normal = results.find((r) => 'normal' === r.tier);
const hard = results.find((r) => 'hard' === r.tier);
if (normal?.calls && hard?.calls) {
  for (let i = 0; i < normal.calls.length; i++) {
    const a = normal.calls[i];
    const b = hard.calls[i];
    if (a && b && a.tokens > 0) {
      scaling[`${a.tool}#${i}`] = {
        normal_tokens: a.tokens,
        hard_tokens: b.tokens,
        token_ratio: Number((b.tokens / a.tokens).toFixed(2)),
        ms_ratio: a.ms > 0 ? Number((b.ms / a.ms).toFixed(2)) : null,
      };
    }
  }
}

const report = {
  metric: 'Reticle cost and latency as the app scales (same app, three sizes)',
  app: APP,
  tiers: results,
  scaling_normal_to_hard: scaling,
};
writeFileSync('bench/raw/stress-tiers.json', JSON.stringify(report, null, 2));
console.log('\n' + JSON.stringify(scaling, null, 2));
process.exit(0);
