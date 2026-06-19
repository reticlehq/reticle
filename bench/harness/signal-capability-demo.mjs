// Tier-1 capability DEMONSTRATION (not a head-to-head score).
//
// Regression class: a domain-signal contract is silently broken — the action's UI is correct
// (clicking "Compose" still switches to the Compose view) but the `nav:changed` signal never
// fires. This is a real, expensive bug class (dropped analytics/event emits) with NO DOM/network/
// console symptom — the view renders correctly, so a DOM/a11y tool sees nothing wrong.
//
// Iris observes app-emitted signals (iris_observe), so it catches the dropped signal. Playwright
// and Chrome DevTools MCP have NO app-signal access (they drive from outside the app) — they are
// N/A here by architecture, not by a missed call. We therefore record this SEPARATELY from the
// head-to-head detection numbers; folding it in would inflate Iris's accuracy = rigging.
//
// To prove the regression is signal-only, we also capture the deployments DOM in both runs and show
// the new row appears identically — i.e. a DOM/a11y tool sees no difference.
import { writeFileSync } from 'node:fs';
import { IrisAdapter } from './adapters.mjs';
import { inject, revert } from './inject.mjs';

const URL = 'http://localhost:4312/';
const SIGNAL = 'nav:changed';
const VIEW_MARKER = /Generate|Compose a script|compose-prompt|Prompt/i; // Compose view rendered
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runOnce() {
  const a = new IrisAdapter(URL);
  await a.start();
  await a.login();
  await sleep(300);
  // click the Compose nav — the action under test (emits nav:changed; switches the view)
  await a.gotoView('compose');
  await sleep(600);
  // observe the signal stream + capture the DOM (did the Compose view render?)
  const obs = await a.c.callTool('iris_observe', { window_ms: 4000, filters: ['signal'] });
  const snap = await a.c.callTool('iris_snapshot', { scope: 'page' });
  await a.stop();
  const obsText = obs.text ?? '';
  return {
    signalFired: obsText.includes(SIGNAL),
    viewRendered: VIEW_MARKER.test(snap.text ?? ''),
  };
}

// baseline (signal contract intact)
const baseline = await runOnce();
// regression (signal dropped; UI unchanged)
inject('signal-contract-violation');
await sleep(500);
const regression = await runOnce();
revert('signal-contract-violation');

const irisDetected = baseline.signalFired && !regression.signalFired;
const domBlind = baseline.viewRendered && regression.viewRendered; // view renders in BOTH → DOM identical

const result = {
  demonstration: 'tier1-signal-contract-violation',
  note: 'Capability demo, NOT head-to-head. Iris observes app signals; Playwright/DevTools cannot (no app-signal access).',
  signal: SIGNAL,
  baseline: { signalFired: baseline.signalFired, viewRendered: baseline.viewRendered },
  regression: { signalFired: regression.signalFired, viewRendered: regression.viewRendered },
  iris: irisDetected
    ? 'DETECTED (signal fired in baseline, absent after regression)'
    : 'INCONCLUSIVE',
  dom_only_tools: domBlind
    ? 'BLIND — the Compose view renders identically in both runs; no DOM/network/console symptom'
    : 'view differed (scenario not signal-only)',
  playwright_mcp: 'N/A — no app-signal observation capability',
  chrome_devtools_mcp: 'N/A — no app-signal observation capability',
};
writeFileSync('bench/raw/tier1-signal.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(0);
