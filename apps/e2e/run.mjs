// E2E orchestrator: run each committed spec sequentially against already-running servers
// (api:8787, demo:3000, next-smoke:3100). Each spec boots its own Iris bridge on :4400, so we
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
  'm57-test',
  'p2-drive-test',
  'spa-nav-realinput-test',
  'visual-test',
  'crawl-test',
  'p3a-test',
  'p3b-test',
  'project-history-test',
  'p4-spec',
  'live-control-test',
  'real-world-tests',
];
const present = new Set(readdirSync(specsDir).map((f) => f.replace(/\.mjs$/, '')));
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
