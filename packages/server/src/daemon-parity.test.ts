import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `start` and `startDaemon` must wire the same session-lifecycle machinery.
 *
 * They drifted once and it was invisible: `startDaemon` attached journal CAPTURE but never the session-END
 * flush, never seeded the learned ambient map, and never routed CDP network detail. Since `reticle serve`
 * and `reticle mcp` both go through `startDaemon`, the path every user takes silently dropped each
 * session's journal tail and could never converge ambient learning across sessions — while the tests,
 * which exercise `start`, stayed green.
 *
 * The fix is shared helpers. This test guards the fix: it asserts BOTH entry points route through them,
 * so re-inlining the wiring in one path (which is how the drift happened) fails here instead of in
 * production. A behavioural test cannot catch this — the divergence is in which wiring is installed, and
 * both paths otherwise behave identically until a session ends.
 */

const SOURCE = readFileSync(join(__dirname, 'index.ts'), 'utf8');

/** Body of a top-level `export async function <name>(` up to the next top-level declaration. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  if (-1 === start) throw new Error(`${name} not found in index.ts`);
  const next = source.indexOf('\nexport ', start + 1);
  return source.slice(start, -1 === next ? source.length : next);
}

const ENTRY_POINTS = ['start', 'startDaemon'] as const;

/** Every helper that installs session-lifecycle wiring. Both entry points must call each one. */
const REQUIRED_WIRING = [
  {
    call: 'attachJournal(',
    why: 'journal capture + ambient seeding + journal-tail flush at session end',
  },
  {
    call: 'makeNetworkDetailRouter(',
    why: 'CDP-authoritative network detail routed onto the session',
  },
] as const;

describe('start() and startDaemon() lifecycle parity', () => {
  for (const entry of ENTRY_POINTS) {
    for (const { call, why } of REQUIRED_WIRING) {
      it(`${entry}() wires ${call} — ${why}`, () => {
        expect(functionBody(SOURCE, entry)).toContain(call);
      });
    }
  }

  it('neither entry point re-inlines the wiring the helpers own', () => {
    // Re-inlining is exactly how the paths drifted: one copy was updated, the other was not. The helper
    // bodies legitimately contain these calls, so only the entry-point bodies are checked.
    for (const entry of ENTRY_POINTS) {
      const body = functionBody(SOURCE, entry);
      expect(body).not.toContain('bridge.attachSessionEnd(');
      expect(body).not.toContain('makeJournalAttach(');
      expect(body).not.toContain('seedAmbient(');
    }
  });
});
