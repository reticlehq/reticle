// State/UI-desync benchmark (the capability gap competitors cannot cross).
// A CLASS of two distinct lies, each requiring the app's STATE as source of truth:
//   state-desync  — a COUNT lies: the Deployments nav badge is forced to 0 while the store keeps the
//                   real count. Reticle reads the store (reticle_state) → mismatch; a DOM tool sees a
//                   plausible number and has no truth to compare against.
//   status-stale  — a STATUS lies: the top deployment row renders a different status than the store
//                   holds (a failed/in-flight deploy shown as "live", correct color + dot). Reticle
//                   reads deployments[0].status → mismatch; a DOM tool sees a healthy, self-consistent
//                   pill and cannot know it shipped nothing.
// Brutal-honest: each competitor attempt genuinely tries the common store globals and finds none —
// the store was registered with Reticle, not hung on window.
import { writeFileSync } from 'node:fs';
import { PlaywrightAdapter, DevtoolsAdapter, ReticleAdapter } from './adapters.mjs';
import { measure } from './tokenizer.mjs';

const BASE = process.env.BENCH_URL ?? 'http://localhost:4312/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const buggedUrl = (bug) => `${BASE}${BASE.includes('?') ? '&' : '?'}reticle-bug=${bug}`;
const STATUS_ROW_ID = 4000;
const STATUS_WORDS = ['building', 'queued', 'failed', 'live'];

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
// First status keyword present in an element's rendered text (the displayed pill word).
const statusIn = (s) =>
  STATUS_WORDS.find((w) =>
    String(s ?? '')
      .toLowerCase()
      .includes(w),
  ) ?? null;

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

// ---------- state-desync (count) ----------
async function reticleCount() {
  return withTool(new ReticleAdapter(buggedUrl('state-desync')), async (a) => {
    await a.login();
    await sleep(700);
    // path scopes the read to the deployments array; depth:0 collapses it to "[Array(N)]" so the
    // count is cheap to read. The store value comes back in `value` (not stores.app).
    const st = await a.c.callTool('reticle_state', { store: 'app', path: 'deployments', depth: 0 });
    const sj = parseJson(st.text);
    const truth = countOf(sj.value);
    const q = parseJson(
      (await a.c.callTool('reticle_query', { by: 'testid', value: 'nav-deployments' })).text,
    );
    const ins = parseJson(
      (await a.c.callTool('reticle_inspect', { ref: (q.elements ?? [])[0]?.ref })).text,
    );
    const displayed = digits(ins.name);
    const tokens = measure(st.text ?? '').tokens_o200k + measure(ins.text ?? '').tokens_o200k;
    return { truth, displayed, detected: bothDiffer(truth, displayed), tokens };
  });
}

const COUNT_COMPETITOR_FN = `() => {
  const badge = document.querySelector('[data-testid="nav-deployments"] .nav-badge');
  const displayed = badge ? parseInt(badge.textContent, 10) : null;
  const g = window;
  const candidates = [g.__APP_STORE__, g.store, g.useApp, g.__zustand__, g.__REDUX_DEVTOOLS_EXTENSION__];
  let truth = null;
  for (const c of candidates) { try { const s = typeof c === 'function' ? c.getState && c.getState() : c; if (s && Array.isArray(s.deployments)) { truth = s.deployments.length; break; } } catch {} }
  return { displayed, truth };
}`;

async function competitorCount(Adapter, evalTool) {
  return withTool(new Adapter(buggedUrl('state-desync')), async (a) => {
    await a.login();
    await sleep(700);
    const res = await a.c.callTool(evalTool, { function: COUNT_COMPETITOR_FN });
    const o = parseJson(res.text);
    return {
      truth: o.truth ?? null,
      displayed: o.displayed ?? null,
      detected: bothDiffer(o.truth, o.displayed),
      tokens: measure(res.text ?? '').tokens_o200k,
      inputTokens: measure(COUNT_COMPETITOR_FN).tokens_o200k,
    };
  });
}

// ---------- status-stale (per-entity status) ----------
async function reticleStatus() {
  return withTool(new ReticleAdapter(buggedUrl('status-stale')), async (a) => {
    await a.login();
    await a.clickTestid('nav-deployments');
    await sleep(900);
    const st = await a.c.callTool('reticle_state', {
      store: 'app',
      path: `deployments.0.status`,
    });
    const truth = String(parseJson(st.text).value ?? '').toLowerCase() || null;
    const q = parseJson(
      (await a.c.callTool('reticle_query', { by: 'testid', value: `row-${STATUS_ROW_ID}` })).text,
    );
    const ref = (q.elements ?? [])[0]?.ref;
    const ins = parseJson((await a.c.callTool('reticle_inspect', { ref })).text);
    // A row has no aggregated accessible NAME; its rendered status lives in the visible TEXT
    // (`describe` returns `text` = collapsed textContent). Read that to see the displayed pill word.
    const displayed = statusIn(ins.text ?? ins.name);
    const tokens = measure(st.text ?? '').tokens_o200k + measure(ins.text ?? '').tokens_o200k;
    return { truth, displayed, detected: bothDifferStr(truth, displayed), tokens };
  });
}

const STATUS_COMPETITOR_FN = `() => {
  const row = document.querySelector('[data-testid="row-${STATUS_ROW_ID}"]');
  const badges = row ? [...row.querySelectorAll('.badge')] : [];
  const badge = badges.find((b) => b.querySelector('.dot'));
  const displayed = badge ? badge.textContent.trim().toLowerCase() : null;
  const g = window;
  const candidates = [g.__APP_STORE__, g.store, g.useApp, g.__zustand__];
  let truth = null;
  for (const c of candidates) { try { const s = typeof c === 'function' ? c.getState && c.getState() : c; if (s && Array.isArray(s.deployments) && s.deployments[0]) { truth = String(s.deployments[0].status || '').toLowerCase(); break; } } catch {} }
  return { displayed, truth };
}`;

async function competitorStatus(Adapter, evalTool, navName) {
  return withTool(new Adapter(buggedUrl('status-stale')), async (a) => {
    await a.login();
    if (a.clickTestid) await a.clickTestid('nav-deployments', 'Deployments');
    else if (a.clickByName) await a.clickByName(navName, 'Deployments');
    await sleep(900);
    const res = await a.c.callTool(evalTool, { function: STATUS_COMPETITOR_FN });
    const o = parseJson(res.text);
    const truth = o.truth ? String(o.truth).toLowerCase() : null;
    const displayed = o.displayed ? statusIn(o.displayed) : null;
    return {
      truth,
      displayed,
      detected: bothDifferStr(truth, displayed),
      tokens: measure(res.text ?? '').tokens_o200k,
      inputTokens: measure(STATUS_COMPETITOR_FN).tokens_o200k,
    };
  });
}

const bothDiffer = (a, b) =>
  a !== null && a !== undefined && b !== null && b !== undefined && a !== b;
const bothDifferStr = (a, b) => Boolean(a) && Boolean(b) && a !== b;

const guard = (p) => p.catch((e) => ({ error: String(e).slice(0, 80) }));

const instances = {};
// count
instances['state-desync'] = {
  reticle: await guard(reticleCount()),
  playwright: await guard(competitorCount(PlaywrightAdapter, 'browser_evaluate')),
  devtools: await guard(competitorCount(DevtoolsAdapter, 'evaluate_script')),
};
// status
instances['status-stale'] = {
  reticle: await guard(reticleStatus()),
  playwright: await guard(competitorStatus(PlaywrightAdapter, 'browser_evaluate', /Deployments/)),
  devtools: await guard(competitorStatus(DevtoolsAdapter, 'evaluate_script', /Deployments/)),
};

const verdict = (r) =>
  r?.detected
    ? 'CAUGHT'
    : r?.error
      ? `ERR(${r.error})`
      : `missed (no truth: ${r?.truth ?? 'null'})`;

const tally = { reticle: 0, playwright: 0, devtools: 0 };
for (const [bug, tools] of Object.entries(instances)) {
  for (const t of ['reticle', 'playwright', 'devtools']) if (tools[t]?.detected) tally[t] += 1;
  console.log(
    `${bug.padEnd(14)} reticle ${verdict(instances[bug].reticle)} | playwright ${verdict(
      instances[bug].playwright,
    )} | devtools ${verdict(instances[bug].devtools)}`,
  );
}

const summary = {
  layer: 'State/UI desync CLASS (store truth vs displayed)',
  instances,
  detected: tally,
  total: Object.keys(instances).length,
};
writeFileSync('bench/raw/state-desync-bench.json', JSON.stringify(summary, null, 2));
console.log(
  `\n=== state-desync class (of ${summary.total}): reticle ${tally.reticle} | playwright ${tally.playwright} | devtools ${tally.devtools} ===`,
);
process.exit(0);
