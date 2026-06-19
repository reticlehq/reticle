// Hard benchmark — batch 2: STATE/UI DESYNC (the capability gap competitors cannot cross).
// The Deployments nav badge is forced to a wrong count (0) while the store keeps the real one — the
// UI lies about the truth. Detecting it needs a SOURCE OF TRUTH (the app's store):
//   Iris       → iris_state reads the registered store directly → compares to the displayed badge.
//   Playwright → browser_evaluate can read the badge, but the store is NOT on any global it can
//   DevTools   → evaluate_script    reach (it was registered with Iris) → no truth → cannot detect.
// Brutal-honest: the competitor attempt genuinely tries common store globals and finds none.
import { writeFileSync } from 'node:fs';
import { PlaywrightAdapter, DevtoolsAdapter, IrisAdapter } from './adapters.mjs';
import { measure } from './tokenizer.mjs';

const BASE = process.env.BENCH_URL ?? 'http://localhost:4312/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const buggedUrl = (on) =>
  on ? `${BASE}${BASE.includes('?') ? '&' : '?'}iris-bug=state-desync` : BASE;

function firstBalanced(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}
function parseJson(text) {
  if (!text) return {};
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const c = fence ? fence[1] : firstBalanced(text);
  try {
    return c ? JSON.parse(c) : {};
  } catch {
    return {};
  }
}
// Trailing digits (for a badge label like "Deployments0" → 0).
const digits = (s) => {
  const m = String(s ?? '').match(/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
};
// Count from a store value: a real array, a number, or a depth-capped marker "[Array(N)]".
const countOf = (v) => {
  if (Array.isArray(v)) return v.length;
  if (typeof v === 'number') return v;
  const m = String(v ?? '').match(/Array\((\d+)\)/) ?? String(v ?? '').match(/(\d+)/);
  return m ? Number(m[1]) : null;
};

async function withTool(adapter, fn) {
  try {
    await adapter.start();
  } catch {
    await adapter.stop().catch(() => {});
    await sleep(1000);
    await adapter.start();
  }
  try {
    return await fn(adapter);
  } finally {
    await adapter.stop();
  }
}

// Iris: read the store truth (iris_state) + the displayed badge (inspect) → detect a mismatch.
async function irisCheck(bugged) {
  return withTool(new IrisAdapter(buggedUrl(bugged)), async (a) => {
    await a.login();
    await sleep(700);
    // path scopes the read to the deployments array; depth:0 collapses it to "[Array(N)]" so the
    // count is cheap to read. The store value comes back in `value` (not stores.app).
    const st = await a.c.callTool('iris_state', { store: 'app', path: 'deployments', depth: 0 });
    const sj = parseJson(st.text);
    const truth = countOf(sj.value); // "[Array(N)]" → N (the real deployment count from the store)
    const q = parseJson(
      (await a.c.callTool('iris_query', { by: 'testid', value: 'nav-deployments' })).text,
    );
    const ins = parseJson(
      (await a.c.callTool('iris_inspect', { ref: (q.elements ?? [])[0]?.ref })).text,
    );
    const displayed = digits(ins.name);
    const tokens = measure(st.text ?? '').tokens_o200k + measure(ins.text ?? '').tokens_o200k;
    return {
      truth,
      displayed,
      detected: truth !== null && displayed !== null && truth !== displayed,
      tokens,
    };
  });
}

// Competitor: read the displayed badge + genuinely try to find a store source-of-truth on globals.
const COMPETITOR_FN = `() => {
  const badge = document.querySelector('[data-testid="nav-deployments"] .nav-badge');
  const displayed = badge ? parseInt(badge.textContent, 10) : null;
  // Honest attempt to find a source of truth a DOM tool could reach:
  const g = window;
  const candidates = [g.__APP_STORE__, g.store, g.useApp, g.__zustand__, g.__REDUX_DEVTOOLS_EXTENSION__];
  let truth = null;
  for (const c of candidates) { try { const s = typeof c === 'function' ? c.getState && c.getState() : c; if (s && Array.isArray(s.deployments)) { truth = s.deployments.length; break; } } catch {} }
  return { displayed, truth };
}`;

async function competitorCheck(name, Adapter, evalTool, bugged) {
  return withTool(new Adapter(buggedUrl(bugged)), async (a) => {
    await a.login();
    await sleep(700);
    const res = await a.c.callTool(evalTool, { function: COMPETITOR_FN });
    const o = parseJson(res.text);
    return {
      displayed: o.displayed ?? null,
      truth: o.truth ?? null,
      detected:
        o.truth !== null &&
        o.truth !== undefined &&
        o.displayed !== null &&
        o.truth !== o.displayed,
      tokens: measure(res.text ?? '').tokens_o200k,
      inputTokens: measure(COMPETITOR_FN).tokens_o200k,
    };
  });
}

const tools = {};
tools.iris = await irisCheck(true);
console.log('iris      ', JSON.stringify(tools.iris));
tools.playwright = await competitorCheck(
  'playwright',
  PlaywrightAdapter,
  'browser_evaluate',
  true,
).catch((e) => ({ error: String(e).slice(0, 80) }));
console.log('playwright', JSON.stringify(tools.playwright));
tools.devtools = await competitorCheck('devtools', DevtoolsAdapter, 'evaluate_script', true).catch(
  (e) => ({ error: String(e).slice(0, 80) }),
);
console.log('devtools  ', JSON.stringify(tools.devtools));

const summary = {
  layer: 'Hard batch 2 — state/UI desync (store truth vs displayed)',
  bug: 'state-desync',
  tools,
};
writeFileSync('bench/raw/hard-bench-state.json', JSON.stringify(summary, null, 2));
const d = (t) =>
  tools[t]?.detected
    ? 'CAUGHT'
    : tools[t]?.error
      ? 'ERR'
      : `missed (no store truth: ${tools[t]?.truth ?? 'null'})`;
console.log(
  `\n=== state-desync: iris ${d('iris')} | playwright ${d('playwright')} | devtools ${d('devtools')} ===`,
);
process.exit(0);
