// Live proof: the `state` predicate catches a UI-vs-store desync in ONE deterministic iris_assert
// call — no LLM, no manual read-state/read-DOM/compare dance. Against ?iris-bug=status-stale the row
// renders "live" while the store holds "queued":
//   assert deployments.0.status === 'queued' → PASS  (store truth)
//   assert deployments.0.status === 'live'   → FAIL  (the displayed lie; named in the failure)
import { IrisAdapter } from './adapters.mjs';

const BASE = process.env.BENCH_URL ?? 'http://localhost:4312/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = `${BASE}${BASE.includes('?') ? '&' : '?'}iris-bug=status-stale`;

const a = new IrisAdapter(url);
await a.start();
try {
  await a.login();
  await a.clickTestid('nav-deployments');
  await sleep(900);
  const assertState = async (equals) => {
    const r = await a.c.callTool('iris_assert', {
      predicate: { kind: 'state', store: 'app', path: 'deployments.0.status', equals },
      timeout_ms: 0,
    });
    return r.text ?? '';
  };
  const truthy = await assertState('queued');
  const lie = await assertState('live');
  console.log('assert status==queued (store truth):', truthy.slice(0, 200));
  console.log('assert status==live   (display lie):', lie.slice(0, 240));
} finally {
  await a.stop();
}
process.exit(0);
