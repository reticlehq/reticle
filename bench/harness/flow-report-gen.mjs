// Generate the human confidence report for a recorded flow (Phase 3 artifact).
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { IrisAdapter } from './adapters.mjs';
import { measure } from './tokenizer.mjs';
import { buildFlowReport } from '../../packages/server/dist/flows/flow-report.js';

const URL = 'http://localhost:4312/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NAME = 'report-verify-500';
const a = new IrisAdapter(URL);
await a.start();
try {
  await a.c.callTool('iris_record_start', { recordingName: NAME });
  await a.login();
  await a.gotoView('diagnostics');
  await sleep(400);
  await a.clickTestid('fault-500');
  await sleep(500);
  await a.c.callTool('iris_annotate', {
    flow: NAME,
    kind: 'intent',
    text: 'inject a 500 server fault from diagnostics and observe it fire',
  });
  await a.c.callTool('iris_annotate', {
    flow: NAME,
    kind: 'success-state',
    signal: 'fault:injected',
  });
  await a.c.callTool('iris_record_stop', { recordingName: NAME });
  await a.c.callTool('iris_flow_save', { flowName: NAME });
  await a.c.callTool('iris_refresh', { hard: true });
  await sleep(2000);
  const repRaw = (await a.c.callTool('iris_flow_replay', { flowName: NAME })).text;
  const replay = JSON.parse(repRaw);
  const flow = JSON.parse(readFileSync(`.iris/flows/${NAME}.json`, 'utf8'));
  const replayTokens = measure(repRaw).tokens_o200k;
  const md = buildFlowReport({ flow, replay, replayTokens, competitorTokens: 30249 });
  mkdirSync('bench/artifacts', { recursive: true });
  writeFileSync('bench/artifacts/sample-flow-report.md', md);
  console.log(
    'wrote bench/artifacts/sample-flow-report.md  (status=' +
      replay.status +
      ', tokens=' +
      replayTokens +
      ')',
  );
} finally {
  await a.stop();
}
