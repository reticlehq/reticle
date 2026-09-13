import { describe, expect, it } from 'vitest';
import { replayProgram } from './replay.js';
import { INVOKE_TOOL, type CompiledProgram } from './recording/tape/recordings.js';
import type { Session } from '../../portal/session/session.js';

/**
 * Replaying a composite.
 *
 * The invoke branch is handled BEFORE the session is touched, which is what lets these run against
 * a session that would throw if used: every case here is decided by reading the documents, and a
 * replayer that needed a live subject to notice a missing sub-flow would have already driven half a
 * journey before finding out.
 *
 * The refusals matter more than the happy path. A composite whose sub-flow cannot be resolved must
 * FAIL — passing would mean it replayed green having silently skipped a sub-journey, which is the
 * false green this whole layer exists to prevent, arriving through the feature meant to strengthen
 * it.
 */

const unusable = new Proxy(
  {},
  {
    get() {
      throw new Error('the session must not be touched to decide an invocation');
    },
  },
) as unknown as Session;

const program = (name: string, invokes: string[]): CompiledProgram => ({
  name,
  version: 1,
  steps: invokes.map((flow) => ({ tool: INVOKE_TOOL, args: { flow }, stable: true, invoke: flow })),
});

describe('replaying an invoke step', () => {
  it('fails, naming the document, when the sub-flow cannot be resolved', async () => {
    const results = await replayProgram(
      unusable,
      program('full', ['signup']),
      false,
      () => undefined,
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.error).toContain('signup');
  });

  it('fails rather than skipping when the replayer has no resolver at all', async () => {
    // Silently passing an invoke it cannot follow is the worst available answer: the composite
    // reports green for a journey it never ran.
    const results = await replayProgram(unusable, program('full', ['signup']));
    expect(results[0]?.ok).toBe(false);
  });

  it('addresses the failure to the call site, through nesting', async () => {
    const docs: Record<string, CompiledProgram> = {
      mid: program('mid', ['missing']),
    };
    const results = await replayProgram(unusable, program('top', ['mid']), false, (n) => docs[n]);
    const failed = results.find((r) => !r.ok);
    expect(failed?.at).toBe('mid#0 (invoked from top#0)');
  });

  it('refuses a cycle at REPLAY time too, not only at typecheck', async () => {
    // Typecheck catches this at rest, and the replayer must not trust that: the document set can
    // change between the check and the run, and an infinite replay is not a thing to discover live.
    const docs: Record<string, CompiledProgram> = {
      a: program('a', ['b']),
      b: program('b', ['a']),
    };
    const results = await replayProgram(
      unusable,
      docs['a'] as CompiledProgram,
      false,
      (n) => docs[n],
    );
    const failed = results.find((r) => !r.ok);
    expect(failed?.error).toContain('a → b → a');
  });

  it('reports each sub-flow it entered, so a green composite says what it ran', async () => {
    const docs: Record<string, CompiledProgram> = {
      leaf: { name: 'leaf', version: 1, steps: [] },
    };
    const results = await replayProgram(unusable, program('top', ['leaf']), false, (n) => docs[n]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results[0]?.note).toContain('leaf');
  });
});
