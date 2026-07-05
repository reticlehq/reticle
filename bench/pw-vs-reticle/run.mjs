// Thin-slice runner for the Playwright-script vs Reticle-script axis.
// Boots apps/bench-app if needed, runs both deterministic harnesses over the bug registry
// (buggy + clean variants), aggregates detection / false-positive / cost, writes a scorecard.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUGS, APP_ORIGIN } from './bugs.mjs';
import { runReticle } from './reticle-harness.mjs';
import { runPlaywright } from './playwright-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const API_ORIGIN = 'http://localhost:8787';
async function up(url) { try { const r = await fetch(url); return r.ok; } catch { return false; } }

async function ensure(name, healthUrl, cmd, args, err) {
  if (await up(healthUrl)) return null;
  console.log(`booting ${name}…`);
  const proc = spawn(cmd, args, { cwd: REPO, stdio: 'ignore', detached: true });
  proc.unref();
  for (let i = 0; i < 40; i++) { if (await up(healthUrl)) return proc; await sleep(500); }
  throw new Error(err);
}

// The bench-app does a real POST /api/login to apps/api (:8787); both must be up.
async function ensureApp() {
  const api = await ensure('apps/api', `${API_ORIGIN}/api/health`, 'node', ['apps/api/server.mjs'], 'apps/api did not come up on 8787');
  const app = await ensure('apps/bench-app', APP_ORIGIN, 'pnpm', ['--filter', '@reticlehq/bench-app', 'dev'], 'bench-app did not come up on 4312');
  return [api, app].filter(Boolean);
}

const expectsFor = (h, expect) =>
  expect === 'both' || (h === 'reticle-script' ? expect === 'reticle-only' : expect === 'playwright-only');

function aggregate(rows) {
  const byH = {};
  for (const h of ['reticle-script', 'playwright-script']) {
    const buggy = rows.filter((r) => r.harness === h && r.variant === 'buggy');
    const clean = rows.filter((r) => r.harness === h && r.variant === 'clean');
    const expected = buggy.filter((r) => expectsFor(h, r.expect));
    byH[h] = {
      bugs: buggy.length,
      caught: buggy.filter((r) => r.caught).length,
      expected: expected.length,
      caughtOfExpected: expected.filter((r) => r.caught).length,
      falsePositives: clean.filter((r) => r.caught).length,
      avgBytes: Math.round(buggy.reduce((a, r) => a + r.bytes, 0) / buggy.length),
      avgMs: Math.round(buggy.reduce((a, r) => a + r.ms, 0) / buggy.length),
    };
  }
  return byH;
}

function scorecard(rows, agg) {
  const cell = (h, id) => {
    const r = rows.find((x) => x.harness === h && x.bug === id && x.variant === 'buggy');
    return r?.caught ? '✅' : '⬜';
  };
  const lines = [];
  lines.push('# Playwright-script vs Reticle-script — thin slice\n');
  lines.push(`App under test: \`apps/bench-app\` (${APP_ORIGIN}). Deterministic scripts, no LLM.\n`);
  lines.push('| Bug | Category | Expected catcher | Reticle-script | Playwright-script |');
  lines.push('|---|---|---|:--:|:--:|');
  for (const b of BUGS) lines.push(`| ${b.id} | ${b.category} | ${b.expect} | ${cell('reticle-script', b.id)} | ${cell('playwright-script', b.id)} |`);
  lines.push('\n## Summary\n');
  lines.push('| Metric | Reticle-script | Playwright-script |');
  lines.push('|---|--:|--:|');
  const R = agg['reticle-script'], P = agg['playwright-script'];
  lines.push(`| Bugs caught | ${R.caught}/${R.bugs} | ${P.caught}/${P.bugs} |`);
  lines.push(`| Caught of those it *can* catch | ${R.caughtOfExpected}/${R.expected} | ${P.caughtOfExpected}/${P.expected} |`);
  lines.push(`| False positives (clean build) | ${R.falsePositives} | ${P.falsePositives} |`);
  lines.push(`| Avg output consumed / bug | ${R.avgBytes} B | ${P.avgBytes} B |`);
  lines.push(`| Avg wall-time / bug | ${R.avgMs} ms | ${P.avgMs} ms |`);
  lines.push('\n> "Expected catcher" is the ground-truth capability line: `both`, `reticle-only` (needs app state / commit stream), or `playwright-only` (needs pixels).');
  return lines.join('\n') + '\n';
}

(async () => {
  const procs = await ensureApp();
  await sleep(1000);
  console.log('running reticle-script harness…');
  const reticleRows = await runReticle(BUGS);
  console.log('running playwright-script harness…');
  const pwRows = await runPlaywright(BUGS);
  const rows = [...reticleRows, ...pwRows];
  const agg = aggregate(rows);
  writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify({ rows, agg }, null, 2));
  const md = scorecard(rows, agg);
  writeFileSync(path.join(__dirname, 'SCORECARD.md'), md);
  console.log('\n' + md);
  console.table(agg);
  for (const p of procs) { try { process.kill(-p.pid); } catch {} }
  process.exit(0);
})().catch((e) => { console.error('RUN ERROR', e); process.exit(1); });
