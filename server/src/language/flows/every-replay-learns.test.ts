/**
 * Every ordinary replay path writes back what it learned — and the two that must not, do not.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────────
 * `persistLearning` had ONE call site, on `reticle_flow_replay`. `replayNamedFlow` had eight.
 * Everything else replayed and threw the lesson away: both branches of `reticle_flow_verify` — the
 * tool whose own description calls it "the autonomous regression check to run after a build/change"
 * — the panel's ▶ button, the Runs pipeline, and the unperturbed branch of the seed path.
 *
 * Promotion requires CONSECUTIVE clean runs (`learnFromRun`, `cleanRuns`). A suite that never writes
 * `learned` back therefore starts from zero on every run and promotes nothing, ever. The headline
 * claim of this release — a flow gets stricter without anybody writing an assertion — was inert on
 * the path a team automates, and it looked fine: the result still REPORTS `learned` and `promoted`,
 * because `flow-replay-run.ts` computes them on every path. Only the write was missing.
 *
 * ── WHY THIS IS PARTLY A SOURCE CHECK ───────────────────────────────────────────────────────────
 * Its sibling `learning-reaches-the-flow.test.ts` records, in its own header, that a `readFileSync`
 * + `toContain` version of itself was a false green. That warning is about asserting a CALL EXISTS
 * by matching text. This asserts the opposite — that a call does NOT exist outside a declared set —
 * which text can answer honestly: adding a direct caller reddens it, and no comment can satisfy it.
 * The behavioural half is below it, and the two are checked together on purpose.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FlowReplayResult } from '@reticlehq/core';
import type { ToolDeps } from '@/surface/tools/tools.js';
import { REPO_ROOT } from '@/machine/repo-root.js';
import { persistLearning } from './flow-learning.js';

/**
 * Every place allowed to call `replayNamedFlow` directly, how many times, and why.
 *
 * Counted per CALL rather than per file, because two of these files also contain replays that DO
 * learn — a file-level exemption would have let a new bare call in beside a declared one.
 *
 * The two product exceptions drive the app in a condition it is never really in, so a finding they
 * produce is not a fact about the app. Promotion turns a finding that STOPS appearing into a guard,
 * so the cost is not a wrong guard today: it is a guard earned against a condition that will never
 * recur.
 */
const DIRECT_CALLS_ALLOWED: Readonly<Record<string, { calls: number; why: string }>> = {
  'language/flows/flow-tools.ts': {
    calls: 1,
    why: 'the PERTURBED branch of the seed path — the network is slowed on purpose',
  },
  'language/flows/flow-mutate-tools.ts': {
    calls: 1,
    why: 'mutation testing breaks the app deliberately to check the flow notices',
  },
  'language/flows/flow-replay-run.ts': {
    calls: 1,
    why: "the implementation's own recursion into a nested flow",
  },
  'language/flows/flow-learning.ts': { calls: 1, why: 'the wrapper that adds the learning' },
};

/** Files that replay and must therefore go through the learning wrapper. */
const MUST_LEARN = ['index.ts', 'judgement/runs/runner-port.ts'];

/** Calls, not mentions: an import, a re-export and a comment are none of them. */
function directCalls(file: string): number {
  const source = readFileSync(join(REPO_ROOT, 'server', 'src', file), 'utf8');
  return source.split('\n').filter((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
      return false;
    }
    if (trimmed.startsWith('import') || trimmed.startsWith('export {')) return false;
    return /\breplayNamedFlow\s*\(/.test(line);
  }).length;
}

describe('a replay that is not deliberately broken keeps what it learned', () => {
  it('a file that must learn makes no direct replay call', () => {
    const cheating = MUST_LEARN.filter((file) => directCalls(file) > 0);
    expect(
      cheating,
      'replays without writing back what it learned, so its flow can never promote a finding to a ' +
        'guard. Call replayAndLearn instead.',
    ).toEqual([]);
  });

  for (const [file, allowed] of Object.entries(DIRECT_CALLS_ALLOWED)) {
    it(`${file} keeps exactly ${String(allowed.calls)} direct replay — ${allowed.why}`, () => {
      // Both directions. Over the count is a new replay that silently does not learn; under it is
      // an exemption that has stopped matching anything and now only reads as a decision.
      expect(directCalls(file)).toBe(allowed.calls);
    });
  }

  it('counts calls, not mentions', () => {
    // The denominator. Without it, a regex that matched nothing would pass every case above by
    // reporting zero everywhere — including the MUST_LEARN check, which wants zero.
    expect(directCalls('language/flows/flow-replay-run.ts')).toBeGreaterThan(0);
  });

  it('replayAndLearn writes what the replay learned', async () => {
    const written: { name: string; learned: unknown }[] = [];
    const learned = [{ kind: 'request-never-settled', step: 1, state: 'guarded' as const }];
    const deps = {
      flows: {
        recordLearned: (name: string, value: unknown) => {
          written.push({ name, learned: value });
          return Promise.resolve({ ok: true, value: { name } });
        },
        load: () => Promise.resolve({ ok: true, value: { name: 'checkout', steps: [] } }),
      },
      reticleRoot: '/tmp/none',
      sessions: { resolve: () => ({ projectId: undefined }) },
    } as unknown as ToolDeps;

    const replayed = { status: 'ok', learned } as FlowReplayResult;
    await persistLearning(deps, { flowName: 'checkout' }, replayed);

    expect(written).toHaveLength(1);
    expect(written[0]?.name).toBe('checkout');
    expect(written[0]?.learned).toEqual(learned);
  });
});
