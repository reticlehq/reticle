/**
 * The QA agent's verification core — the SCRIPTED, deterministic driver. This is the analogue of
 * the builder's QA agent running in a build pod: it launches a real headless browser at the preview URL
 * (the "sandbox"), drives the add-expense acceptance flow, and judges it against PROGRAM TRUTH —
 * the network calls, console log, and live app store — not pixels.
 *
 * It exercises the exact path that was previously untested (CLI coding-agent only): an in-process,
 * API-style consumer of Reticle driving a headless sandbox. Each call is fully isolated: its own bridge,
 * its own browser, torn down at the end.
 *
 *   BUG=mock-data node qa/verify-live.mjs        # run one bug class
 *   (or import { verifyPreview } from './verify-live.mjs' — used by bench.mjs)
 */
import {
  start,
  TOOLS,
  BaselineStore,
  RecordingStore,
  FlowStore,
  AnnotationStore,
  ProjectStore,
  createNodeFileSystem,
  LaunchedRealInputProvider,
} from '@reticle/server';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Verdict status mirrors Reticle's own pass/warn/fail. */
const PASS = 'pass';
const FAIL = 'fail';

/**
 * The fix prompt each oracle hands the platform's fixer subagent when it fails — the demo analogue of
 * Reticle's `repair.failurePackets[].suggestedPrompt`. Keyed by check name. This is what closes the loop:
 * a failure is not just "red", it is an actionable instruction grounded in observed program truth.
 */
const FIX_PROMPTS = {
  'POST /api/expenses fires exactly once':
    'Adding one expense fired POST /api/expenses twice. The submit path double-dispatches — guard the handler so one click sends exactly one request.',
  'store persisted the new expense':
    'POST /api/expenses returned 200 but the store did not grow — the handler returns a mocked success instead of persisting. Persist the created expense before responding.',
  'no console errors during add':
    'An error was logged to the console during add while the UI still rendered. Find and remove the throwing/failing code path — a silent console error is a real defect.',
  'invalid amount creates no expense (server-side validation)':
    'Submitting "abc" as an amount created an expense (a NaN row). Add server-side validation: reject non-numeric/empty amounts with 422 and create nothing.',
  'delete removes the row from the store':
    'DELETE returned 200 but the row stayed in the store (desync after refresh). Make the delete handler actually remove the matching id from the collection.',
  'displayed Total matches store total':
    'The Total shown in the UI does not equal the computed store total — the render applies a wrong offset. Render the true store total.',
};

/**
 * Drive + verify one bug class against the running preview.
 * @returns {Promise<{bug:string, status:string, checks:Array<{name:string,status:string,detail:string}>, durationMs:number}>}
 */
export async function verifyPreview({
  bug = 'none',
  previewUrl = 'http://localhost:4310',
  bridgePort = 4400,
  headless = true,
} = {}) {
  const startedAt = Date.now();
  // The QA agent owns the app's lifecycle: reset to a clean slate before the run (the build pod boots fresh).
  await fetch(`${previewUrl}/api/reset`, { method: 'DELETE', headers: { 'x-bug': bug } });

  const server = await start({ port: bridgePort, mcp: false });
  // `reticle=1` tells the page to connect to our bridge — only the harness's own browser does this,
  // never a plain preview iframe, so the two never collide on the session.
  const provider = new LaunchedRealInputProvider({
    driveUrl: `${previewUrl}/?bug=${bug}&reticle=1`,
    headless,
  });
  await provider.navigate(); // launches Chromium → the page's Reticle SDK dials our bridge

  const fs = createNodeFileSystem();
  const reticleRoot = mkdtempSync(join(tmpdir(), 'reticle-vibe-builder-'));
  const now = () => Date.now();
  const deps = {
    sessions: server.bridge.sessions,
    baselines: new BaselineStore(),
    recordings: new RecordingStore(),
    annotations: new AnnotationStore(),
    flows: new FlowStore(fs, reticleRoot, { now }),
    project: new ProjectStore(fs, reticleRoot, { now }),
    fs,
    reticleRoot,
    now,
    realInput: provider,
  };
  const T = (name, args = {}) =>
    TOOLS.find((t) => t.name === name).handler(deps, { sessionId: 'preview', ...args });

  const checks = [];
  // A failing oracle carries the fix prompt the platform's fixer subagent would receive — the
  // analogue of Reticle's `repair.failurePackets[].suggestedPrompt`.
  const check = (name, ok, detail) =>
    checks.push({ name, status: ok ? PASS : FAIL, detail, ...(ok ? {} : { fix: FIX_PROMPTS[name] }) });

  // Tool-call helpers that tolerate the different field names a tool can use across versions.
  const expensesOf = async () => findExpenses(await T('reticle_state', { store: 'app' })) ?? [];
  const totalOf = (state) => {
    const found = (() => {
      const seen = new Set();
      const walk = (v) => {
        if (v === null || typeof v !== 'object' || seen.has(v)) return undefined;
        seen.add(v);
        if (typeof v.total === 'number') return v.total;
        for (const k of Object.keys(v)) {
          const r = walk(v[k]);
          if (r !== undefined) return r;
        }
        return undefined;
      };
      return walk(state);
    })();
    return found;
  };
  const postCount = async () => {
    const posts = await T('reticle_network', { method: 'POST', urlContains: '/api/expenses' });
    const calls = posts.calls ?? posts.requests ?? posts.network ?? [];
    return Array.isArray(calls) ? calls.length : -1;
  };
  const errorCount = async () => {
    const errs = await T('reticle_console', { level: 'error' });
    const list = errs.entries ?? errs.logs ?? errs.console ?? [];
    return Array.isArray(list) ? list.length : -1;
  };
  const fillAndAdd = async (value) => {
    const amount = (await T('reticle_query', { by: 'testid', value: 'amount' })).elements?.[0]?.ref;
    if (amount === undefined) throw new Error('amount input not found');
    await T('reticle_act', { ref: amount, action: 'clear' });
    await T('reticle_act', { ref: amount, action: 'fill', args: { value } });
    const add = (await T('reticle_query', { by: 'testid', value: 'add' })).elements?.[0]?.ref;
    await T('reticle_act_and_wait', { ref: add, action: 'click' });
    await sleep(350);
  };
  const readTestidText = async (testid) =>
    (await T('reticle_query', { by: 'testid', value: testid })).elements?.[0]?.name ?? '';

  try {
    // Wait for the sandbox browser's SDK to connect.
    for (let i = 0; i < 100 && server.bridge.sessions.count() === 0; i++) await sleep(50);
    if (server.bridge.sessions.count() === 0) throw new Error('sandbox SDK never connected to bridge');
    await T('reticle_wait_ready', { timeoutMs: 10000 });

    // ── Step A — add a valid expense (amount=42) ──────────────────────────────
    await fillAndAdd('42');
    const afterAdd = await expensesOf();
    check('POST /api/expenses fires exactly once', (await postCount()) === 1, `${await postCount()} POST(s)`);
    check('store persisted the new expense', afterAdd.length === 1, `store has ${afterAdd.length}`);
    check('no console errors during add', (await errorCount()) === 0, `${await errorCount()} error(s)`);
    // UI-vs-data: the rendered Total must equal the store's computed total (catches a lying UI).
    const storeTotal = totalOf(await T('reticle_state', { store: 'app' }));
    const shownTotal = (await readTestidText('total')).trim();
    check(
      'displayed Total matches store total',
      shownTotal === String(storeTotal),
      `shown "${shownTotal}" vs store "${String(storeTotal)}"`,
    );

    // ── Step B — submit invalid input ("abc") ─────────────────────────────────
    const lenBeforeInvalid = (await expensesOf()).length;
    await fillAndAdd('abc');
    const lenAfterInvalid = (await expensesOf()).length;
    check(
      'invalid amount creates no expense (server-side validation)',
      lenAfterInvalid === lenBeforeInvalid,
      `store len ${lenBeforeInvalid}->${lenAfterInvalid}`,
    );

    // ── Step C — delete a row (only when one exists) ──────────────────────────
    const before = await expensesOf();
    if (before.length > 0) {
      const del = (await T('reticle_query', { by: 'testid', value: 'del' })).elements?.[0]?.ref;
      if (del !== undefined) {
        await T('reticle_act_and_wait', { ref: del, action: 'click' });
        await sleep(350);
        const after = await expensesOf();
        check('delete removes the row from the store', after.length < before.length, `len ${before.length}->${after.length}`);
      }
    }

    const status = checks.every((c) => c.status === PASS) ? PASS : FAIL;
    return { bug, status, checks, durationMs: Date.now() - startedAt };
  } finally {
    await provider.dispose();
    await server.close();
  }
}

/** Pull the expenses array out of whatever shape reticle_state returns. */
function findExpenses(state) {
  const seen = new Set();
  const walk = (v) => {
    if (v === null || typeof v !== 'object' || seen.has(v)) return undefined;
    seen.add(v);
    if (Array.isArray(v.expenses)) return v.expenses;
    for (const key of Object.keys(v)) {
      const found = walk(v[key]);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(state);
}

// CLI entry — run a single bug class and print the verdict.
if (import.meta.url === `file://${process.argv[1]}`) {
  const bug = process.env.BUG ?? 'none';
  const previewUrl = process.env.PREVIEW_URL ?? 'http://localhost:4310';
  const bridgePort = Number(process.env.BRIDGE_PORT ?? 4400);
  verifyPreview({ bug, previewUrl, bridgePort })
    .then((v) => {
      console.log(`\n=== verdict for BUG=${bug}: ${v.status.toUpperCase()} (${v.durationMs}ms) ===`);
      for (const c of v.checks) console.log(`  ${c.status === PASS ? '✅' : '❌'} ${c.name} — ${c.detail}`);
      process.exit(v.status === PASS ? 0 : 1);
    })
    .catch((err) => {
      console.error('verify harness error:', err);
      process.exit(2);
    });
}
