/**
 * The self-healing loop — the complete the builder value story in one run:
 *
 *   generate (with a bug) → Reticle verify → FAIL + failure packet → fixer applies the fix →
 *   Reticle re-verify → PASS → gate opens.
 *
 * Honest framing: regenerating the corrected code is the PLATFORM's job (its fixer subagent). Reticle's
 * role is the un-hallucinatable verdict and the grounded failure packet that drives the fixer, then
 * the re-verification that proves the fix actually worked. Here the "fixer" is simulated by swapping
 * the buggy variant for the corrected one — the loop and the evidence are real.
 *
 *   PREVIEW_URL=http://localhost:4318 BRIDGE_PORT=4422 BUG=mock-data node qa/repair-loop.mjs
 */
import { verifyPreview } from './verify-live.mjs';

const PREVIEW_URL = process.env.PREVIEW_URL ?? 'http://localhost:4310';
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT ?? 4400);
const BUG = process.env.BUG ?? 'mock-data';

/**
 * Run the loop. The "fixer" is a function (bug) => correctedBug; here it returns 'none' (the platform
 * regenerated working code). Returns the full transcript so the UI / a report can render it.
 */
export async function repairLoop({ bug, previewUrl, bridgePort, fixer = () => 'none', maxRepairs = 2 } = {}) {
  const transcript = [];
  let current = bug;
  for (let attempt = 1; attempt <= maxRepairs + 1; attempt++) {
    const verdict = await verifyPreview({ bug: current, previewUrl, bridgePort });
    const packets = verdict.checks.filter((c) => c.status === 'fail').map((c) => ({ check: c.name, detail: c.detail, fix: c.fix }));
    transcript.push({ attempt, ranWith: current, status: verdict.status, durationMs: verdict.durationMs, packets });
    if (verdict.status === 'pass') return { bug, repaired: attempt > 1, attempts: attempt, transcript };
    if (attempt === maxRepairs + 1) break; // out of repair budget
    current = fixer(current, packets); // the platform's fixer regenerates from the packet(s)
  }
  return { bug, repaired: false, attempts: transcript.length, transcript };
}

// CLI entry.
if (import.meta.url === `file://${process.argv[1]}`) {
  repairLoop({ bug: BUG, previewUrl: PREVIEW_URL, bridgePort: BRIDGE_PORT })
    .then((r) => {
      console.log(`\n=== self-healing loop for BUG=${r.bug} ===\n`);
      for (const step of r.transcript) {
        const tag = step.status === 'pass' ? '✅ PASS' : '❌ FAIL';
        console.log(`Attempt ${step.attempt} — ran build "${step.ranWith}" → ${tag} (${step.durationMs}ms)`);
        for (const p of step.packets) {
          console.log(`   ✗ ${p.check} — ${p.detail}`);
          console.log(`     ↳ failure packet → fixer: ${p.fix}`);
        }
        if (step.status === 'fail' && step.attempt <= r.transcript.length - 1) {
          console.log(`   → fixer applies the fix and regenerates…\n`);
        }
      }
      console.log(
        `\n${r.repaired ? '🟢' : '🔴'} ${r.repaired ? `Build healed in ${r.attempts - 1} repair(s) — gate opens, user never saw the bug.` : 'Still failing after the repair budget — gate stays closed.'}`,
      );
      process.exit(r.repaired || r.bug === 'none' ? 0 : 1);
    })
    .catch((err) => {
      console.error('repair loop error:', err);
      process.exit(2);
    });
}
