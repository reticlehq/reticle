// E2E orchestrator: run each committed spec sequentially against already-running servers
// (api:8787, demo:4310, next-smoke:3100). Each spec boots its own Reticle bridge on :4400, so we
// free that port between specs. Exits non-zero if any spec fails — the CI regression gate.
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const specsDir = path.join(dir, 'specs');

// Order: next-smoke-backed specs first, real-world (demo+api) last.
const ORDER = [
  'next-smoke-test',
  'next-blur-clock-test',
  'status-honesty-test',
  'drive-launch-test',
  'spa-nav-realinput-test',
  'visual-test',
  'crawl-test',
  'scroll-find-test',
  'flow-record-replay-test',
  'flow-self-heal-test',
  'project-history-test',
  'spec-runner-test',
  'live-control-test',
  'real-world-tests',
  'multi-agent-lease-test',
];
// Specs intentionally excluded from the battery (add here WITH a reason, never by omission).
const SKIP = new Set([]);
const present = new Set(
  readdirSync(specsDir)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => f.replace(/\.mjs$/, '')),
);
// ORDER only SEQUENCES; a spec present on disk but in neither ORDER nor SKIP is silently un-run rot
// (this is how new-features-test.mjs rotted). Fail loud so every new spec must be classified.
const unclassified = [...present].filter((n) => !ORDER.includes(n) && !SKIP.has(n));
if (unclassified.length > 0) {
  console.error(
    `\ne2e: spec(s) present but not in ORDER or SKIP: ${unclassified.join(', ')}\n` +
      'Add each to ORDER (to run, in sequence) or SKIP (to exclude, with a reason).',
  );
  process.exit(1);
}
const specs = ORDER.filter((n) => present.has(n));

const sh = (cmd) =>
  new Promise((res) => spawn('bash', ['-c', cmd], { stdio: 'ignore' }).on('close', () => res()));
const freePort = () => sh('lsof -tiTCP:4400 -sTCP:LISTEN | xargs kill 2>/dev/null; sleep 1');

let failed = 0;
for (const name of specs) {
  await freePort();
  process.stdout.write(`\n──────── ${name} ────────\n`);
  const code = await new Promise((res) =>
    spawn('node', [path.join(specsDir, `${name}.mjs`)], { stdio: 'inherit' }).on('close', res),
  );
  if (code !== 0) {
    failed += 1;
    process.stdout.write(`\n[e2e] ✗ ${name} FAILED (exit ${code})\n`);
  }
}

await freePort();
process.stdout.write(
  `\n================ e2e battery: ${specs.length - failed}/${specs.length} specs passed ================\n`,
);
process.exit(failed === 0 ? 0 : 1);
