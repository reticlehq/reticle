// The fix-loop ablation. For each injected bug, a Claude Code subagent fixes it WITH the
// Reticle MCP vs WITHOUT it; we measure fixed-correctly rate (deterministic re-check), tokens, tool
// calls, and wall-time. This is the release's before/after number — run first to set the 2.1.0 baseline,
// re-run last for the delta. Publish honestly either way.
//
// This file is the HARNESS + orchestration. Running the full ablation spawns a fleet of live agent
// loops (API budget) against a booted bench app + Reticle daemon — that is the MEASUREMENT the operator
// authorizes. `--selftest` validates the harness (inject → unfixed → revert → fixed) with NO agent, so
// the deterministic scaffolding is provably correct before any budget is spent.
import { fileURLToPath } from 'node:url';
import { inject, listRegressions, revert, signaturesOf } from '../harness/inject.mjs';
import { isFixed } from './verify.mjs';

const CONDITIONS = ['with-reticle', 'without-reticle'];

/**
 * Fix one bug under one condition. `fixAgent(bugId, condition)` is injected — the real runner passes a
 * function that spawns a Claude Code subagent (with or without the Reticle MCP registered) and returns
 * { tokens, toolCalls, wallMs }. Kept injectable so the loop is testable without live agents.
 */
export async function runCell(bugId, condition, fixAgent) {
  inject(bugId);
  const start = Date.now();
  let agentStats = { tokens: 0, toolCalls: 0, wallMs: 0 };
  try {
    agentStats = (await fixAgent(bugId, condition)) ?? agentStats;
  } finally {
    // Re-check BEFORE revert — revert would trivially "fix" it and corrupt the measurement.
  }
  const fixed = isFixed(bugId);
  revert(bugId);
  return { bugId, condition, fixed: fixed === true, ...agentStats, wallMs: Date.now() - start };
}

/** Run every (bug × condition) cell and summarize the fixed-correctly rate + cost per condition. */
export async function runAblation(fixAgent, bugs = listRegressions()) {
  const checkable = bugs.filter((id) => signaturesOf(id).length > 0);
  const cells = [];
  for (const bugId of checkable) {
    for (const condition of CONDITIONS) {
      cells.push(await runCell(bugId, condition, fixAgent));
    }
  }
  const summary = {};
  for (const condition of CONDITIONS) {
    const rows = cells.filter((c) => c.condition === condition);
    const fixed = rows.filter((c) => c.fixed).length;
    summary[condition] = {
      fixedRate: rows.length === 0 ? 0 : fixed / rows.length,
      fixed,
      total: rows.length,
      tokens: rows.reduce((s, c) => s + c.tokens, 0),
      toolCalls: rows.reduce((s, c) => s + c.toolCalls, 0),
    };
  }
  return {
    cells,
    summary,
    checkableBugs: checkable.length,
    skipped: bugs.length - checkable.length,
  };
}

// ── Runnable self-check: no agent, no API budget. Proves the deterministic scaffolding is sound. ──
async function selftest() {
  const bugs = listRegressions().filter((id) => signaturesOf(id).length > 0);
  let ok = 0;
  for (const id of bugs) {
    inject(id);
    const unfixed = isFixed(id) === false; // injected marker present ⇒ NOT fixed
    revert(id);
    const fixed = isFixed(id) === true; // marker gone ⇒ fixed
    if (unfixed && fixed) ok += 1;
    else console.error(`SELFTEST FAIL ${id}: unfixed=${unfixed} fixedAfterRevert=${fixed}`);
  }
  if (ok !== bugs.length) {
    console.error(`fix-loop selftest: ${ok}/${bugs.length} bugs round-tripped`);
    process.exit(1);
  }
  console.log(`fix-loop selftest OK: ${ok}/${bugs.length} bugs inject→unfixed→revert→fixed`);
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--selftest')) {
  await selftest();
}
