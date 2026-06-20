#!/usr/bin/env node
/**
 * Partner harness — drive an Iris verdict from your own pipeline. No MCP, no human.
 *
 * This is the whole integration: POST your run metadata, get back a stable IrisVerificationRun, and
 * gate your deploy on the verdict. The same artifact your agent's inner loop produces.
 *
 * Prerequisite: the Iris verify endpoint is running and your generated app/preview is connected
 *   (start it with: `iris serve --http --http-token <TOKEN>` — see docs/integration.md).
 *
 * Usage:  IRIS_TOKEN=… node docs/oem-verify-harness.mjs https://preview-url.example
 */

const IRIS_URL = process.env.IRIS_URL ?? 'http://127.0.0.1:7331';
const TOKEN = process.env.IRIS_TOKEN ?? '';

const res = await fetch(`${IRIS_URL}/verify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-iris-token': TOKEN },
  body: JSON.stringify({
    project: { name: 'my-generated-app', framework: 'react', previewUrl: process.argv[2] },
    trigger: { kind: 'oem', diffRef: process.env.GIT_SHA },
    // names: ['signup', 'checkout'],  // omit to verify every saved flow
  }),
});

const { run } = await res.json();
console.log(
  `verdict: ${run.verdict.status}  ·  ${run.flows.length} flows  ·  ${run.verdict.blockingRisks} blocking risks`,
);
for (const f of run.flows.filter((f) => f.status === 'fail')) {
  console.log(`  ✗ ${f.name}: ${f.failureReason ?? 'failed'}`);
}
for (const p of run.repair?.failurePackets ?? []) {
  console.log(`  fix: ${p.suggestedPrompt}`);
}

// Gate the deploy on the verdict (PARTIAL/FAIL → non-zero exit).
process.exit(run.verdict.status === 'pass' ? 0 : 1);
