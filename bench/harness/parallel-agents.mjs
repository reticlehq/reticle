// 2-agent parallel cell: two agents on ONE daemon, each in its own tab, replay one flow at once.
//
// Several agents now drive one project at the same time, each in its own worktree or tab. This cell
// measures that path instead of assuming it works:
//   - correctness: agent B's tab carries a console-error bug (`?reticle-bug=console-leak`), agent A's
//     does not. A must hold and B must be caught. A verdict that crosses tabs shows as A failing or
//     B holding (`cross_talk`).
//   - price: A's replay tokens in parallel against A's replay tokens alone.
// No duration is asserted (a timing bound fails only under load). Needs the bench fixtures up
// (`pnpm bench` boots them; this script does not).
import { writeFileSync } from 'node:fs';
import { ReticleAdapter } from './adapters.mjs';
import { measure } from './tokenizer.mjs';
import { BENCH_URL } from './ports.mjs';
import { agentUrl, gradeParallelCell } from './parallel-agents-cell.mjs';

const FLOW = 'parallel-compose';
const BUG = 'console-leak';
const CONSOLE = { level: 'error', absent: true };
const SETTLE_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parse = (t) => {
  try {
    return JSON.parse(t || '{}');
  } catch {
    return {};
  }
};
// The fixture's own sign-in password, as bench-all hands it to every pass. Not a secret.
process.env.RETICLE_SECRET_LOGIN_PASSWORD ??= 'password';

async function replayOnce(a) {
  const rep = await a.c.callTool('reticle_flow_replay', { flowName: FLOW });
  const obj = parse(rep.text);
  const steps = Array.isArray(obj.steps) ? obj.steps : [];
  const successRow = steps.find((s) => s && 'success' === s.tool);
  return {
    sessionId: a.sessionId ?? null,
    status: obj.status ?? 'unknown',
    successOk: successRow?.ok ?? null,
    drifted: steps.some((s) => s && s.drift),
    tokens: measure(rep.text || '').tokens_o200k,
  };
}

/** Agent A records the flow: sign in, Compose, type, Generate, then a clean-console consequence. */
async function record(a) {
  await a.c.callTool('reticle_record', { action: 'start', recordingName: FLOW });
  await a.login();
  await a.gotoView('compose');
  await sleep(300);
  const prompt = await a._refByTestid('compose-prompt');
  if (prompt.ref) {
    await a.c.callTool('reticle_act', {
      ref: prompt.ref,
      action: 'fill',
      args: { value: 'two agents, one daemon' },
    });
  }
  await a.clickTestid('compose-generate');
  await sleep(1200);
  await a.c.callTool('reticle_annotate', { flow: FLOW, kind: 'success-state', console: CONSOLE });
  await a.c.callTool('reticle_record', { action: 'stop', recordingName: FLOW });
  await a.c.callTool('reticle_flow_save', { flowName: FLOW });
}

const a = new ReticleAdapter(agentUrl(BENCH_URL, 'a'));
const b = new ReticleAdapter(agentUrl(BENCH_URL, 'b'));
let result;
try {
  await a.start();
  await record(a);
  await a.refresh();
  await sleep(SETTLE_MS);
  const solo = await replayOnce(a);

  await b.start();
  await b.c.callTool('reticle_navigate', { url: agentUrl(BENCH_URL, 'b', BUG) });
  await a.refresh();
  await sleep(SETTLE_MS);
  const [parallelA, parallelB] = await Promise.all([replayOnce(a), replayOnce(b)]);
  const separateTabs = null !== parallelA.sessionId && parallelA.sessionId !== parallelB.sessionId;
  result = {
    solo,
    parallelA,
    parallelB,
    separate_tabs: separateTabs,
    ...gradeParallelCell({ solo, parallelA, parallelB }),
  };
  result.correct = result.correct && separateTabs;
} finally {
  await Promise.allSettled([a.stop(), b.stop()]);
}

const summary = {
  dimension: '2-agent parallel cell: two agents on one daemon replay one flow at the same time',
  scenario: `agent A on the clean page, agent B on ?reticle-bug=${BUG}`,
  oracle: 'flow.success console { level:error, absent:true }',
  ...result,
  honest_verdict: result.correct
    ? `Parallel path CORRECT: A held, B was caught, no cross-talk. A paid ${String(result.parallel_token_overhead_pct)}% more tokens in parallel than alone.`
    : 'NOT CORRECT: a verdict crossed tabs, or the solo replay did not hold. Investigate before claiming the parallel path.',
};
writeFileSync('bench/raw/parallel-agents.json', JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exit(result.correct ? 0 : 1);
