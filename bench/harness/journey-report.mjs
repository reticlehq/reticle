// Journey + intent evidence report (Layer C, narrative): the artifact a developer/agent reads to
// see WHAT a regression run did and WHETHER the business goal held — deterministic, no LLM.
//
// Records a flow that declares its business intent and asserts the consequence that defines success,
// then replays it and renders the journey: per step the page, the action, and the observable
// consequence (signal/network/route), plus the outcome verdict (status + intentVerified). Measures
// the token cost of the whole evidence artifact — this is what a CI run or an agent reads per run.
import { writeFileSync } from 'node:fs';
import { IrisAdapter } from './adapters.mjs';
import { measure } from './tokenizer.mjs';

const URL = process.env.BENCH_URL ?? 'http://localhost:4312/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LLM_REDRIVE = 30249; // Playwright per-run LLM re-drive (Layer B)

const FLOW = {
  name: 'r-verify-500',
  intent: 'inject a 500 server fault from diagnostics and observe it fire',
  success: 'fault:injected',
};

async function recordReplay() {
  const a = new IrisAdapter(URL);
  await a.start();
  try {
    await a.c.callTool('iris_record_start', { recordingName: FLOW.name });
    await a.login();
    await sleep(500);
    await a.gotoView('diagnostics');
    await sleep(400);
    await a.clickTestid('fault-500');
    await sleep(500);
    // Declare the business intent + the consequence that defines success.
    await a.c.callTool('iris_annotate', { flow: FLOW.name, kind: 'intent', text: FLOW.intent });
    await a.c.callTool('iris_annotate', {
      flow: FLOW.name,
      kind: 'success-state',
      signal: FLOW.success,
    });
    await a.c.callTool('iris_record_stop', { recordingName: FLOW.name });
    const saved = JSON.parse((await a.c.callTool('iris_flow_save', { flowName: FLOW.name })).text);

    await a.c.callTool('iris_refresh', { hard: true });
    await sleep(2000);
    const rep = await a.c.callTool('iris_flow_replay', { flowName: FLOW.name });
    return { saved, replayText: rep.text || '', replay: JSON.parse(rep.text || '{}') };
  } finally {
    await a.stop();
  }
}

const { saved, replayText, replay } = await recordReplay();
const assertions = saved.assertions ?? {};
const tokens = measure(replayText).tokens_o200k;

// Render the human/agent-legible journey.
const lines = [];
lines.push(`intent: ${assertions.intent ?? '(none)'}`);
lines.push(`status: ${replay.status}   intentVerified: ${assertions.intentVerified}`);
lines.push('journey:');
for (const s of replay.steps ?? []) {
  const page = s.page ?? '-';
  const verdict = s.ok ? 'ok' : `DRIFT ${s.drift?.anchor ?? ''}`.trim();
  const consequence = s.consequence ? `  =>  ${s.consequence}` : '';
  lines.push(`  [${page}] ${s.anchor} ${verdict}${consequence}`);
}
const report = lines.join('\n');

const summary = {
  layer: 'C-narrative (intent + journey evidence report)',
  intent: assertions.intent ?? null,
  intentVerified: assertions.intentVerified ?? null,
  status: replay.status,
  report_tokens: tokens,
  playwright_redrive_tokens: LLM_REDRIVE,
  ratio_vs_playwright: tokens ? Math.round(LLM_REDRIVE / tokens) : null,
  report,
};
writeFileSync('bench/raw/journey-report.json', JSON.stringify(summary, null, 2));
console.log(report);
console.log(
  `\n=== evidence report ${tokens} tok (intentVerified=${assertions.intentVerified}) vs Playwright ${LLM_REDRIVE} re-drive => ${summary.ratio_vs_playwright}x ===`,
);
process.exit(0);
