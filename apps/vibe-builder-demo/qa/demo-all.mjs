/**
 * One green-or-red gate for the whole demo — a pre-meeting smoke check. Boots the preview (the Vite
 * server hosting the sandbox + Builder UI + APIs), then runs every layer as a pass/fail step:
 *   • bench       — Reticle catches 6/6 silent classes, blind 0/6, 0 false positives
 *   • repair      — self-healing loop reaches green (mock-data)
 *   • self-test   — Reticle-tests-Reticle, buggy build blocked (scripted) and (live, if LLM_API_KEY set)
 *   • self-test   — Reticle-tests-Reticle, clean build passes (no false positive)
 * Exits non-zero if any step fails. Tears the preview down on the way out.
 *
 *   node qa/demo-all.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PREVIEW_PORT = 4318;
const BRIDGE_PORT = 4422;
const PREVIEW_URL = `http://localhost:${PREVIEW_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Does .env carry a live key? (the live self-test step is included only then)
function hasLiveKey() {
  if (process.env.LLM_API_KEY) return true;
  try {
    return /^LLM_API_KEY=\S+/m.test(readFileSync(join(APP_DIR, '.env'), 'utf8'));
  } catch {
    return false;
  }
}

function run(label, file, env) {
  return new Promise((resolve) => {
    process.stdout.write(`\n──────── ${label} ────────\n`);
    const child = spawn('node', [join('qa', file)], {
      cwd: APP_DIR,
      stdio: 'inherit',
      env: { ...process.env, PREVIEW_URL, BRIDGE_PORT: String(BRIDGE_PORT), ...env },
    });
    child.on('close', (code) => resolve({ label, ok: code === 0 }));
  });
}

async function waitForPreview(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${PREVIEW_URL}/api/reticle-config`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(400);
  }
  return false;
}

// Boot the preview (Vite) ourselves so this is one self-contained command.
const vite = spawn(join(APP_DIR, 'node_modules', '.bin', 'vite'), ['--port', String(PREVIEW_PORT), '--strictPort'], {
  cwd: APP_DIR,
  stdio: 'ignore',
  env: { ...process.env, RETICLE_PREVIEW_PORT: String(PREVIEW_PORT), RETICLE_PREVIEW_BRIDGE_PORT: String(BRIDGE_PORT) },
});

const results = [];
try {
  if (!(await waitForPreview(15000))) throw new Error('preview server did not come up on :4318');

  results.push(await run('bench — Reticle 6/6 vs blind 0/6', 'bench.mjs'));
  results.push(await run('repair — self-healing loop (mock-data)', 'repair-loop.mjs', { BUG: 'mock-data' }));
  results.push(await run('self-test — Reticle⇄Reticle, buggy build blocked (scripted)', 'self-test.mjs', { BUG: 'mock-data', ENGINE: 'scripted' }));
  results.push(await run('self-test — Reticle⇄Reticle, clean build passes (scripted)', 'self-test.mjs', { BUG: 'none', ENGINE: 'scripted' }));
  if (hasLiveKey()) {
    results.push(await run('self-test — Reticle⇄Reticle, buggy build blocked (LIVE agent)', 'self-test.mjs', { BUG: 'double-submit', ENGINE: 'live' }));
  } else {
    process.stdout.write('\n(skipping live-agent self-test — no LLM_API_KEY in .env)\n');
  }
} catch (err) {
  console.error('demo:all error:', err.message ?? err);
  results.push({ label: 'setup', ok: false });
} finally {
  vite.kill();
}

const failed = results.filter((r) => !r.ok);
process.stdout.write('\n================ demo:all summary ================\n');
for (const r of results) process.stdout.write(`  ${r.ok ? '✅' : '❌'} ${r.label}\n`);
process.stdout.write(`\n${failed.length === 0 ? '✅ ALL GREEN' : `❌ ${failed.length} FAILED`} — ${results.length - failed.length}/${results.length} steps passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
