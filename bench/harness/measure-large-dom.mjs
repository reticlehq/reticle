// The token wedge on a LARGE-DOM real-shaped app (apps/large-dom-bench).
//
// The leanness claim is "a targeted verify loop costs a few hundred tokens even when the page is
// huge — because Reticle reads the consequence, not the whole tree." That only shows where a full
// snapshot is expensive, which the small demo (~89-node tree) cannot demonstrate. This harness
// drives the large grid and measures, with NO model and NO API key:
//   - the full page snapshot (reticle_snapshot scope:page)   — the baseline a screenshot/whole-tree tool pays
//   - the verify loop (query -> act_and_wait -> assert)   — what Reticle actually pays per check
// Run apps/large-dom-bench first:  pnpm --filter @reticle/large-dom-bench dev   (defaults to :4313)
import { writeFileSync } from 'node:fs';
import { McpStdioClient } from './mcp-client.mjs';
import { measure } from './tokenizer.mjs';

const URL = process.env.LARGE_DOM_URL ?? 'http://localhost:4313/';
const PORT = process.env.LARGE_DOM_RETICLE_PORT ?? '4456';
const ROW = process.env.LARGE_DOM_ROW ?? '42';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function refFromQuery(text, testid) {
  // reticle_query returns JSON descriptors carrying ref + testid; pull the ref for our testid.
  try {
    const j = JSON.parse(text);
    const list = Array.isArray(j) ? j : (j.elements ?? j.matches ?? []);
    const hit = list.find((e) => e.testid === testid) ?? list[0];
    return hit?.ref;
  } catch {
    const m = text.match(/"ref"\s*:\s*"([^"]+)"/);
    return m?.[1];
  }
}

const c = new McpStdioClient(
  'node',
  ['packages/server/dist/cli.js', 'mcp', '--port', PORT, '--drive', URL],
  { RETICLE_PORT: PORT },
);
await c.start();
// Block until the driven browser's SDK actually connects (no fixed-sleep race).
await c.callTool('reticle_wait_ready', { timeout_ms: 15000 }).catch(() => undefined);
await sleep(300);

const rows = [];
const rec = (call, res) => {
  const m = measure(res.text ?? '');
  rows.push({ call, tokens_o200k: m.tokens_o200k, chars: m.chars, bytes: m.bytes });
  return res;
};

// 1) Full page snapshot — the whole-tree cost.
rec('reticle_snapshot(page)', await c.callTool('reticle_snapshot', { scope: 'page' }));

// 2) The targeted verify loop on one row, deep in the grid. Poll the query until the row resolves
// (a fixed sleep races the large grid's paint); only the resolving call is measured into the loop.
const approveId = `approve-${ROW}`;
let q;
let ref;
for (let i = 0; i < 20; i += 1) {
  q = await c.callTool('reticle_query', { by: 'testid', value: approveId });
  ref = refFromQuery(q.text ?? '', approveId);
  if (ref) break;
  await sleep(200);
}
rec('reticle_query(testid)', q);
if (ref) {
  rec(
    'reticle_act_and_wait',
    await c.callTool('reticle_act_and_wait', {
      ref,
      action: 'click',
      until: { kind: 'signal', name: 'row:approved' },
      timeout_ms: 4000,
    }),
  );
  rec(
    'reticle_assert(signal)',
    await c.callTool('reticle_assert', { predicate: { kind: 'signal', name: 'row:approved' } }),
  );
}
await c.stop();

const snapshot = rows.find((r) => r.call.startsWith('reticle_snapshot'))?.tokens_o200k ?? 0;
const loop = rows
  .filter((r) => r.call !== 'reticle_snapshot(page)')
  .reduce((n, r) => n + r.tokens_o200k, 0);
const out = {
  url: URL,
  ref_resolved: Boolean(ref),
  calls: rows,
  full_snapshot_tokens: snapshot,
  verify_loop_tokens: loop,
  wedge_ratio: loop > 0 ? +(snapshot / loop).toFixed(1) : null,
};
writeFileSync('bench/raw/large-dom-loop.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(0);
