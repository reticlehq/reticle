// Console-error regression (Layer C): the "it works but the log is screaming" class.
//
// The Compose action renders its result fine, but the console-leak regression (`?iris-bug=console-leak`)
// logs a `console.error` on the action — a caught exception, a failed effect, an unhandled rejection.
// The visible UI is unchanged, so a structural/visual/presence check passes. Only asserting a CLEAN
// CONSOLE catches it. Iris expresses that as a flow success consequence `console { absent: true }` (set
// via iris_annotate success-state); on replay the oracle reads the console after the page settles —
// clean = pass, an error = fail, with NO testid drift (the button is present and clicks fine).
//
// Honest scope: Playwright (page.on('console')) and DevTools can both read console — raw capture is
// parity. The win is the same as net.count: a DECLARED, deterministic replay consequence (no LLM
// re-drive), evaluated post-settle so a wait-until-true waiter can't pass before the error fires.
import { writeFileSync } from 'node:fs';
import { IrisAdapter } from './adapters.mjs';
import { measure } from './tokenizer.mjs';

const URL = process.env.BENCH_URL ?? 'http://localhost:4312/';
const LLM_REDRIVE = 30249; // Playwright MCP per-run re-drive (Layer B)
const FLOW = 'console-compose';
const CONSOLE = { level: 'error', absent: true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parse = (t) => {
  try {
    return JSON.parse(t || '{}');
  } catch {
    return {};
  }
};

async function replayOnce(a) {
  const rep = await a.c.callTool('iris_flow_replay', { flowName: FLOW });
  const obj = parse(rep.text);
  const successRow = Array.isArray(obj.steps)
    ? obj.steps.find((s) => s && s.tool === 'success')
    : undefined;
  const drifted = Array.isArray(obj.steps) ? obj.steps.some((s) => s && s.drift) : false;
  return {
    status: obj.status ?? 'unknown',
    successOk: successRow?.ok ?? null,
    drifted,
    tokens: measure(rep.text || '').tokens_o200k,
  };
}

const a = new IrisAdapter(URL);
await a.start();
let result;
try {
  // Record: login → Compose → type a prompt → Generate. Declare the clean-console consequence.
  await a.c.callTool('iris_record_start', { recordingName: FLOW });
  await a.login();
  await a.gotoView('compose');
  await sleep(300);
  const prompt = await a._refByTestid('compose-prompt');
  if (prompt.ref) {
    await a.c.callTool('iris_act', {
      ref: prompt.ref,
      action: 'fill',
      args: { value: 'shipped a faster build pipeline' },
    });
  }
  await a.clickTestid('compose-generate');
  await sleep(1200);
  const ann = await a.c.callTool('iris_annotate', {
    flow: FLOW,
    kind: 'success-state',
    console: CONSOLE,
  });
  await a.c.callTool('iris_record_stop', { recordingName: FLOW });
  await a.c.callTool('iris_flow_save', { flowName: FLOW });

  // Baseline: healthy app — clean console → the absent:error oracle holds.
  await a.c.callTool('iris_refresh', { hard: true });
  await sleep(1500);
  const baseline = await replayOnce(a);

  // Regression: console-leak injected — the action logs a console.error → the oracle fails.
  const buggedUrl = `${URL}${URL.includes('?') ? '&' : '?'}iris-bug=console-leak`;
  await a.c.callTool('iris_navigate', { url: buggedUrl });
  await sleep(1800);
  const regressed = await replayOnce(a);

  const detected =
    baseline.status === 'ok' &&
    baseline.successOk === true &&
    regressed.status !== 'ok' &&
    regressed.successOk === false &&
    regressed.drifted === false;
  result = {
    annotate_compiled: parse(ann.text).compiled ?? null,
    baseline,
    regressed,
    detected,
  };
} finally {
  await a.stop();
}

const summary = {
  dimension:
    'Console-error regression (Layer C) — a clean-console consequence catches a silent log error',
  scenario: 'Compose renders fine but logs a console.error (?iris-bug=console-leak)',
  oracle: 'flow.success console { level:error, absent:true }',
  ...result,
  per_run_tokens: result.regressed?.tokens ?? null,
  ratio_vs_playwright_redrive: result.regressed?.tokens
    ? Math.round(LLM_REDRIVE / result.regressed.tokens)
    : null,
  competitor_position:
    'Playwright/DevTools can read the console, so raw capture is parity — but only Iris replays "clean console" as a declared consequence with no LLM re-drive, evaluated post-settle so it cannot pass before the error fires.',
  honest_verdict: result.detected
    ? `Console-error regression CAUGHT: clean replay holds (no error), bugged replay fails the clean-console oracle with no testid drift — caught deterministically at ~${result.regressed.tokens} tok/run.`
    : 'NOT DETECTED — investigate the injector or the console consequence before claiming the catch.',
};
writeFileSync('bench/raw/console-clean-bench.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(
  `\n=== console-clean: console-error regression ${result.detected ? 'CAUGHT' : 'MISSED'} | clean successOk=${result.baseline?.successOk} bugged successOk=${result.regressed?.successOk} drift=${result.regressed?.drifted} | ~${result.regressed?.tokens} tok/run ===`,
);
process.exit(result.detected ? 0 : 1);
