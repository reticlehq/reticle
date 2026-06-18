import { describe, expect, it } from 'vitest';
import { sizeCost, estimateTokens } from '../session/output-budget.js';
import { applySnapshotDelta, SnapshotCache } from './snapshot-delta.js';

/**
 * M0 — a reproducible measurement of the M2 token wins, run over the REAL shipped functions
 * (sizeCost / estimateTokens / applySnapshotDelta), not a mock. It quantifies the claim "diffed
 * snapshots and re-scoping save the tokens that drive agent context blow-up + selector
 * hallucination". The absolute token figure uses the ~chars/4 heuristic (estimateTokens); the
 * RELATIVE savings (diff vs full) is what matters and is robust to the heuristic. Numbers are
 * asserted as regression guards AND printed (see the test output) so the roadmap can quote them.
 *
 * Representative page: a 150-row operational dashboard (orders table) — the exact shape that makes
 * full snapshots expensive and where an agent typically changes one row at a time.
 */

const ROWS = 150;

function dashboardTree(rows: number, mutatedRow = -1): string {
  const lines = ['- main "Orders" (ref=e1)', '  - table "Orders" (ref=e2)'];
  for (let i = 0; i < rows; i += 1) {
    const status = i === mutatedRow ? 'Shipped' : 'Pending';
    lines.push(
      `    - row "Order #${String(1000 + i)} — Acme Corp — $${String(i * 7 + 19)}.00 — ${status}" (ref=e${String(i + 10)})`,
    );
    lines.push(`      - button "View #${String(1000 + i)}" (ref=e${String(i + 2000)})`);
  }
  return lines.join('\n');
}

function snap(tree: string, route = '/orders'): unknown {
  return { tree, status: { route, title: 'Orders' }, nodes: ROWS * 2 + 2 };
}

function tokensOf(result: unknown): number {
  return sizeCost(result).tokens;
}

describe('M0 — snapshot token cost (M2 wins, measured on real functions)', () => {
  it('a diff after a one-row change costs a tiny fraction of a full re-snapshot', () => {
    const cache = new SnapshotCache();
    const full = snap(dashboardTree(ROWS));
    // First look → full (this is what the agent pays once).
    applySnapshotDelta(full, { sessionId: 's', scope: '', mode: 'full', diff: true }, cache);
    const fullTokens = tokensOf(full);

    // One row flips Pending → Shipped; agent asks for the diff.
    const changed = snap(dashboardTree(ROWS, 42));
    const delta = applySnapshotDelta(
      changed,
      { sessionId: 's', scope: '', mode: 'full', diff: true },
      cache,
    );
    const deltaTokens = tokensOf(delta);

    const savedPct = Math.round((1 - deltaTokens / fullTokens) * 100);
    // eslint-disable-next-line no-console
    console.log(
      `[M0] full re-snapshot=${String(fullTokens)} tok  diff=${String(deltaTokens)} tok  saved=${String(savedPct)}%`,
    );

    expect(fullTokens).toBeGreaterThan(2000); // a 150-row dashboard is genuinely expensive
    expect(deltaTokens).toBeLessThan(fullTokens * 0.1); // diff is <10% of a full re-read
    expect(savedPct).toBeGreaterThanOrEqual(90);
  });

  it('an unchanged re-snapshot collapses to near-zero tokens', () => {
    const cache = new SnapshotCache();
    const full = snap(dashboardTree(ROWS));
    applySnapshotDelta(full, { sessionId: 's', scope: '', mode: 'full', diff: true }, cache);
    const unchanged = applySnapshotDelta(
      snap(dashboardTree(ROWS)),
      { sessionId: 's', scope: '', mode: 'full', diff: true },
      cache,
    );
    const unchangedTokens = tokensOf(unchanged);
    // eslint-disable-next-line no-console
    console.log(`[M0] unchanged re-snapshot=${String(unchangedTokens)} tok`);
    expect(unchangedTokens).toBeLessThan(50);
  });

  it('cost preview reports the full size up front so the agent can bail before reading', () => {
    const full = snap(dashboardTree(ROWS));
    const preview = sizeCost(full);
    // eslint-disable-next-line no-console
    console.log(
      `[M0] cost preview: ${String(preview.tokens)} tok / ${String(preview.bytes)} bytes`,
    );
    expect(preview.tokens).toBe(estimateTokens(JSON.stringify(full)));
    expect(preview.tokens).toBeGreaterThan(2000);
  });
});
