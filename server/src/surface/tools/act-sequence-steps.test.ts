/**
 * A sequence that cannot act must say so, not report success.
 *
 * `steps` is a bare array of objects. A step with neither `ref` nor `target` used to dispatch as
 * `ref: ''` and fail with a stale-ref diagnosis. `target` is accepted — it is the same locator
 * `reticle_act` takes — and a step that names neither is still refused before the first dispatch,
 * so a typo in step three cannot leave one and two applied.
 */
import { describe, expect, it } from 'vitest';
import { assertSequenceSteps, sequenceStepArgs } from './act/act-preflight.js';
import { describeStepResult } from './act/act-sequence-retry.js';

/**
 * A step IS one `reticle_act` call, and `reticle_act` takes its arguments flat.
 *
 * MEASURED driving a real install: `{ ref, action: "fill", value: "…" }` is the obvious way to write
 * it, and the sequence dropped `value` on the floor. The browser then refused — correctly, because a
 * fill with no value used to wipe the field and report success — so the round trip was spent on
 * "pass it nested, as args: { value }". The nested form is what the schema shows and stays valid;
 * the flat one now works too, which is what the tool's own description already implies.
 */
describe('a step written the way reticle_act takes one', () => {
  it('accepts an action argument at the top level', () => {
    expect(sequenceStepArgs({ ref: 'e1', action: 'fill', value: 'a@b.com' })).toEqual({
      value: 'a@b.com',
    });
  });

  it('still accepts the nested form the schema documents', () => {
    expect(sequenceStepArgs({ ref: 'e1', action: 'fill', args: { value: 'x' } })).toEqual({
      value: 'x',
    });
  });

  // An explicit `args` is the one the caller wrote deliberately, so it wins.
  it('prefers the nested value when a step carries both', () => {
    expect(
      sequenceStepArgs({ ref: 'e1', action: 'fill', value: 'flat', args: { value: 'nested' } }),
    ).toEqual({ value: 'nested' });
  });

  // Structure is not an argument: sweeping these in would send `expect` to the browser as one.
  it("never treats the step's own structure as an action argument", () => {
    expect(
      sequenceStepArgs({
        ref: 'e1',
        target: { testid: 't' },
        action: 'fill',
        expect: { kind: 'settled' },
        timeout_ms: 500,
        value: 'v',
      }),
    ).toEqual({ value: 'v' });
  });

  it('carries confirmDangerous through from the top level', () => {
    expect(sequenceStepArgs({ ref: 'e1', action: 'click', confirmDangerous: true })).toEqual({
      confirmDangerous: true,
    });
  });

  it('parses a valid JSON-object string in args (#1230)', () => {
    expect(sequenceStepArgs({ ref: 'e1', action: 'fill', args: '{"value":"hi"}' })).toEqual({
      value: 'hi',
    });
  });

  it('refuses an invalid JSON string in args (#1230)', () => {
    expect(() => sequenceStepArgs({ ref: 'e1', action: 'fill', args: '{broken' })).toThrow(
      /not valid JSON/,
    );
  });

  it('refuses a JSON string that is not an object (#1230)', () => {
    expect(() => sequenceStepArgs({ ref: 'e1', action: 'fill', args: '"just a string"' })).toThrow(
      /not an object/,
    );
  });
});

describe('string args are refused up front so no step is acted on (#1230)', () => {
  it('refuses the whole sequence when a later step has invalid string args', () => {
    expect(() =>
      assertSequenceSteps([
        { ref: 'e1', action: 'click' },
        { ref: 'e2', action: 'fill', args: '{broken' },
      ]),
    ).toThrow(/not valid JSON/);
  });

  it('accepts a sequence where string args parse to a valid object', () => {
    expect(() =>
      assertSequenceSteps([
        { ref: 'e1', action: 'fill', args: '{"value":"hi"}' },
        { ref: 'e2', action: 'click' },
      ]),
    ).not.toThrow();
  });
});

/**
 * A handler-level test that drives `reticle_act_sequence` with string `args` end-to-end.
 *
 * The unit tests above prove that `sequenceStepArgs` parses the string and that
 * `assertSequenceSteps` refuses a malformed one. This test proves the handler itself sends the
 * PARSED object to the page, not the raw string — the difference between "the parser exists" and
 * "the handler calls it".
 */
describe('reticle_act_sequence handler with string args (#1230)', () => {
  // Inline a minimal fake session that records dispatched args, same pattern as
  // act-sequence-burst.test.ts.
  async function dispatchedArgsViaHandler(
    steps: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> {
    const { LastAct } = await import('@/portal/session/last-act.js');
    const { SessionState } = await import('@reticlehq/core');
    const { TOOLS } = await import('./tools.js');
    const { ReticleTool } = await import('@reticlehq/core');
    const { BaselineStore } = await import('@/memory/project/baselines.js');
    const { createNodeFileSystem } = await import('@/memory/project/fs/fs-port.js');
    const { RecordingStore } = await import('@/language/flows/recording/tape/recordings.js');
    const { FlowStore } = await import('@/language/flows/flows.js');
    const { ProjectStore } = await import('@/memory/project/project-store.js');
    const { AnnotationStore } = await import('@/language/flows/stores/annotation-store.js');

    const sent: Record<string, unknown>[] = [];
    let stepIndex = 0;
    const command = (
      name: string,
      args: Record<string, unknown> = {},
    ): Promise<import('@reticlehq/core').CommandResult> => {
      if ('act' === name) {
        sent.push(args);
        const i = stepIndex++;
        return Promise.resolve({
          kind: 'command_result' as const,
          id: 'c',
          ok: true,
          result: {
            ref: `e${String(i + 1)}`,
            action: 'fill',
            dispatched: true,
            settled: true,
            settleReason: null,
            effect: { domMutatedWithin: 1 },
          },
        });
      }
      return Promise.resolve({
        kind: 'command_result' as const,
        id: 'c',
        ok: true,
        result: {},
      });
    };
    const noEvents: import('@reticlehq/core').ReticleEvent[] = [];
    const session = {
      id: 'demo',
      url: 'http://localhost:5173/app',
      elapsed: () => 0,
      lastAct: new LastAct(),
      beginAction: () => 'a1',
      finishAction: () => undefined,
      command,
      queryEvents: () => Promise.resolve(noEvents),
      eventsSince: () => noEvents,
      bufferHealth: () => ({ total: 0, dropped: 0 }),
      lostSince: () => false,
      blindSpots: () => ({}),
      health: () => ({ lastSeenMs: 0, throttled: false, focused: true }),
      throttled: () => false,
      getState: () => SessionState.ACTIVE,
      drainInbox: () => [],
      inboxSize: () => 0,
      onEvent: () => () => undefined,
    };
    const ROOT = '/tmp/reticle-string-args-test/.reticle';
    const deps = {
      sessions: { resolve: () => session },
      baselines: new BaselineStore(),
      recordings: new RecordingStore(),
      flows: new FlowStore(createNodeFileSystem(), ROOT, { now: () => 0 }),
      project: new ProjectStore(createNodeFileSystem(), ROOT, { now: () => 0 }),
      annotations: new AnnotationStore(),
      fs: createNodeFileSystem(),
      reticleRoot: ROOT,
      now: () => 0,
    };
    const tool = TOOLS.find((t) => t.name === ReticleTool.ACT_SEQUENCE);
    if (tool === undefined) throw new Error('no reticle_act_sequence tool');
    await tool.handler(deps as never, { steps });
    return sent.map((c) => (c['args'] ?? {}) as Record<string, unknown>);
  }

  it('a JSON string args on a fill step arrives at the page as a parsed object', async () => {
    const sent = await dispatchedArgsViaHandler([
      { ref: 'e1', action: 'fill', args: '{"value":"hello@test.com"}' },
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ value: 'hello@test.com' });
  });

  it('an invalid JSON string args refuses the whole sequence before any step runs', async () => {
    await expect(
      dispatchedArgsViaHandler([
        { ref: 'e1', action: 'click' },
        { ref: 'e2', action: 'fill', args: '{not json' },
      ]),
    ).rejects.toThrow(/not valid JSON/);
  });
});

describe('refusing a sequence that cannot act', () => {
  it('accepts a step written with `target` instead of `ref`', () => {
    expect(() =>
      assertSequenceSteps([{ target: { testid: 'auth-email' }, action: 'fill' }]),
    ).not.toThrow();
  });

  it('accepts a mixed sequence of refs and targets', () => {
    expect(() =>
      assertSequenceSteps([
        { target: { label: 'Email' }, action: 'fill' },
        { ref: 'e2', action: 'fill' },
        { target: { testid: 'submit' }, action: 'click' },
      ]),
    ).not.toThrow();
  });

  it('names WHICH step is wrong', () => {
    expect(() =>
      assertSequenceSteps([
        { ref: 'e1', action: 'fill' },
        { ref: 'e2', action: 'fill' },
        { action: 'click' },
      ]),
    ).toThrow(/step 2/);
  });

  it('refuses the WHOLE sequence, so a bad step three cannot leave one and two applied', () => {
    // Checked before the first dispatch. Half a journey is worse than none: the page has moved and
    // nothing says how far.
    expect(() => assertSequenceSteps([{ ref: 'e1', action: 'fill' }, { action: 'click' }])).toThrow(
      /Nothing was acted on/,
    );
  });

  it('refuses an empty step list rather than reporting a successful no-op', () => {
    expect(() => assertSequenceSteps([])).toThrow(/no steps/);
  });

  it('refuses a step with an empty ref and no target', () => {
    expect(() => assertSequenceSteps([{ ref: '', action: 'click' }])).toThrow(
      /no `ref` or `target`/,
    );
  });

  it('accepts an empty ref when a target is present', () => {
    // resolveActTarget treats an empty ref as missing and falls through to target.
    expect(() =>
      assertSequenceSteps([{ ref: '', target: { label: 'Email' }, action: 'fill' }]),
    ).not.toThrow();
  });

  it('refuses junk in the steps array', () => {
    for (const junk of [null, 'a step', 42, []]) {
      expect(() => assertSequenceSteps([junk]), JSON.stringify(junk)).toThrow();
    }
  });

  it('accepts a well-formed sequence', () => {
    expect(() =>
      assertSequenceSteps([
        { ref: 'e1', action: 'fill', args: { value: 'a@b.com' } },
        { ref: 'e2', action: 'click' },
      ]),
    ).not.toThrow();
  });

  it('accepts a document-key press with neither ref nor target', () => {
    expect(() =>
      assertSequenceSteps([{ action: 'press', args: { text: 'Escape' } }]),
    ).not.toThrow();
    expect(() =>
      assertSequenceSteps([
        { ref: 'e1', action: 'click' },
        { action: 'press', args: { text: 'k', modifiers: ['Meta'] } },
      ]),
    ).not.toThrow();
  });

  it('still refuses a default Enter press with no locator — that key submits a control', () => {
    expect(() => assertSequenceSteps([{ action: 'press', args: { text: 'Enter' } }])).toThrow(
      /no `ref` or `target`/,
    );
  });
});

describe('what a step reports', () => {
  it('falls back to the step’s own ref and action when the act did not echo them', () => {
    const out = describeStepResult({ ref: 'e1', action: 'fill' }, {});
    expect(out['ref']).toBe('e1');
    expect(out['action']).toBe('fill');
  });

  it('prefers what the act actually reported', () => {
    const out = describeStepResult({ ref: 'e1', action: 'fill' }, { ref: 'e9', action: 'type' });
    expect(out['ref']).toBe('e9');
    expect(out['action']).toBe('type');
  });

  it('omits fields the act did not produce, rather than filling a row with nulls', () => {
    // A row of nulls reads as "we looked and found nothing" instead of "there was nothing to look for".
    const out = describeStepResult({ ref: 'e1', action: 'click' }, {});
    expect('testid' in out).toBe(false);
    expect('warning' in out).toBe(false);
  });

  it('carries the identifying fields when they are there', () => {
    const out = describeStepResult(
      { ref: 'e1', action: 'click' },
      { testid: 'submit', role: 'button', name: 'Sign In', source: 'src/x.tsx:1' },
    );
    expect(out['testid']).toBe('submit');
    expect(out['name']).toBe('Sign In');
  });
});

/**
 * A sub-step reads `{ ref | target, action, args }` and NOTHING else. The schema is
 * `z.record(z.unknown())`, so any other key is accepted and dropped — and the keys an agent is most
 * likely to reach for are the ones that claim a consequence, because `until` is what the neighbouring
 * act_and_wait calls its assertion.
 *
 * Driven against the Electron fixture, a step carrying `until: { kind: 'net', urlContains:
 * 'this-endpoint-does-not-exist-at-all' }` returned `completed: 1` with no error and no mention of
 * the predicate. The endpoint cannot exist, so the assertion could never hold; nothing evaluated it.
 * An agent reads `completed` plus `settled: true` and records a consequence that was never checked.
 *
 * The honest answer is to refuse and name the key that IS read, the same way an unsupported native
 * click is refused rather than faked. `expect` was on this list until the tool learned to grade one
 * per step — see the block below, and the live drive that found the door still locked.
 */
describe('a sub-step cannot silently carry an assertion it will never grade', () => {
  for (const key of ['until', 'assert', 'waitFor']) {
    it(`refuses a step carrying \`${key}\``, () => {
      expect(() =>
        assertSequenceSteps([{ ref: 'e1', action: 'click', [key]: { kind: 'settled' } }]),
      ).toThrow(/does not read[\s\S]*`expect`/);
    });
  }

  it('names the offending step and key so the caller can fix it', () => {
    expect(() =>
      assertSequenceSteps([
        { ref: 'e1', action: 'click' },
        { ref: 'e2', action: 'click', until: {} },
      ]),
    ).toThrow(/step 1[\s\S]*until/);
  });

  it('still accepts the documented shape', () => {
    expect(() =>
      assertSequenceSteps([
        { ref: 'e1', action: 'fill', args: { value: 'a' } },
        { target: { testid: 't' }, action: 'click' },
      ]),
    ).not.toThrow();
  });
});

/**
 * The preflight was written when a sub-step genuinely could not be graded, and stayed that way after
 * it could.
 *
 * `reticle_act_sequence` now takes `expect` per step, parses it, grades it, and returns
 * `stopped_at` — and its own schema tells the agent so: *"`expect` … is what makes a step PROVE
 * something"*. The preflight runs first and refused every step carrying one, so an agent following
 * the tool's own documentation got a hard refusal and the whole graded path was unreachable.
 *
 * No unit test could see it: they call `gradeSequence` and the handler internals directly. It took a
 * live drive of a three-step plan to hit the door that was still locked.
 *
 * The other three keys stay refused. `until`, `assert` and `waitFor` are still keys this tool does
 * not read, and silently dropping one manufactures the false green the refusal exists to stop — but
 * the answer is now "you want `expect`", not "go and use another tool".
 */
describe('the consequence an agent declares on a sub-step', () => {
  const expectStep = {
    ref: 'e1',
    action: 'click',
    expect: { kind: 'signal', name: 'todo:added' },
  };

  it('accepts `expect`, which this tool grades', () => {
    expect(() => assertSequenceSteps([expectStep])).not.toThrow();
  });

  it('accepts it beside steps that declare nothing', () => {
    expect(() =>
      assertSequenceSteps([{ ref: 'e0', action: 'fill', args: { value: 'a' } }, expectStep]),
    ).not.toThrow();
  });

  for (const key of ['until', 'assert', 'waitFor']) {
    it(`still refuses \`${key}\`, which is read by nothing and would be dropped`, () => {
      expect(() =>
        assertSequenceSteps([{ ref: 'e1', action: 'click', [key]: { kind: 'signal', name: 'x' } }]),
      ).toThrow(/expect/);
    });
  }
});

/**
 * An `expect` the tool cannot parse must be REFUSED, never counted as nothing declared.
 *
 * The handler used `PredicateSchema.safeParse` and, on failure, pushed `{ declared: false }`. So an
 * agent that wrote `expect: { kind: 'signal', name: "order:placed" }` — a plausible spelling, and wrong, the
 * shape is `{ kind: "signal", name: ... }` — got back *"all 3 steps declared nothing, so the app was
 * driven but not verified"*. It had declared. Nobody told it the declaration was thrown away, and
 * the sentence it did get invites it to add the very thing it just wrote.
 *
 * That is the same false green the unreadable-key refusal above exists to prevent, arriving through
 * a key the tool DOES read. Measured on a live daemon, which is also the only place it shows: the
 * handler tests construct predicates that parse.
 *
 * Refused in the preflight, before the first dispatch, for the reason every other refusal here is:
 * half a journey is worse than none.
 */
describe('an expect this tool cannot parse', () => {
  it('refuses a plausible but wrong predicate spelling', () => {
    expect(() =>
      // The flat v1 spelling, which this tool has never accepted: it takes a PREDICATE. A saved
      // flow file may still contain one and is lifted on read; an argument to a live tool is not a
      // file, so it is refused rather than guessed at.
      assertSequenceSteps([{ ref: 'e1', action: 'click', expect: { signal: 'order:placed' } }]),
    ).toThrow(/step 0[\s\S]*expect/);
  });

  it('names what a predicate looks like, so the fix does not need another round trip', () => {
    expect(() =>
      assertSequenceSteps([{ ref: 'e1', action: 'click', expect: { signal: 'order:placed' } }]),
    ).toThrow(/kind/);
  });

  it('refuses rather than dropping it, so nothing is acted on', () => {
    expect(() =>
      assertSequenceSteps([
        { ref: 'e1', action: 'fill', args: { value: 'a' } },
        { ref: 'e2', action: 'click', expect: 'the receipt appears' },
      ]),
    ).toThrow(/Nothing was acted on/);
  });

  it('still accepts every predicate the grader understands', () => {
    expect(() =>
      assertSequenceSteps([
        { ref: 'e1', action: 'click', expect: { kind: 'signal', name: 'order:placed' } },
        { ref: 'e2', action: 'click', expect: { kind: 'element', by: 'testid', value: 'receipt' } },
        { ref: 'e3', action: 'click', expect: { kind: 'settled' } },
      ]),
    ).not.toThrow();
  });
});

/**
 * A ref that was never minted is refused for the whole sequence, up front.
 *
 * Checked only when its step ran, a malformed ref in step three was found after steps one and two
 * had already clicked and filled the page — the half-applied journey this preflight exists to stop.
 */
describe('a step whose ref Reticle never issued', () => {
  it('refuses the sequence before any step runs, naming the step', () => {
    expect(() =>
      assertSequenceSteps([
        { ref: 'e1', action: 'click' },
        { ref: 'e2', action: 'fill', args: { value: 'x' } },
        { ref: 'find:aria-label=Open menu', action: 'click' },
      ]),
    ).toThrow(
      /step 2: "find:aria-label=Open menu" is not a ref Reticle issued.*Nothing was acted on/s,
    );
  });

  it('still accepts minted-shape refs, and a target beside them', () => {
    expect(() =>
      assertSequenceSteps([
        { ref: 'e12', action: 'click' },
        { target: { role: 'button', name: 'Save' }, action: 'click' },
      ]),
    ).not.toThrow();
  });
});
