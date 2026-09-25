/**
 * A saved flow step must be able to assert what the drive that produced it asserted.
 *
 * `reticle_act_and_wait` takes `{ kind: "allOf", predicates: [...] }`. A flow file's `expect` was a
 * flat object whose `signal` field is a string, so the same three-channel claim written the way an
 * agent already knows how to write it failed as `flow_parse_failed` with "malformed" — a JSON
 * syntax error in a file they had just written. Reducing it to `net` alone "fixed" it, which is
 * how this read as a one-kind limit.
 *
 * Coerce the act_and_wait grammar (and the sibling-channel spelling with `signal: { name, count }`)
 * into the on-disk FlowExpect shape. Name the step and key when a shape still cannot be accepted.
 */
import { describe, expect, it } from 'vitest';
import { FLOW_FILE_VERSION, FlowErrorCode, FlowFileSchema } from '@reticlehq/core';
import {
  FlowParseNote,
  coerceFlowExpect,
  coerceFlowFileExpects,
  describeFlowZodFailure,
  parseFlowFileText,
} from './flow-expect-grammar.js';
import { flowExpectHasConsequence } from '@reticlehq/core';

const REPORTER_EXPECT = {
  net: { method: 'POST', urlContains: '/decode', count: 1 },
  signal: { name: 'scan:complete', count: 1 },
  state: { store: 'app', path: 'scan.status', equals: 'done' },
};

/** What the v1 reporter expect above means once the schema has lifted it. */
const LIFTED_REPORTER = {
  kind: 'allOf',
  predicates: [
    { kind: 'settled' },
    { kind: 'signal', name: 'scan:complete', count: 1 },
    { kind: 'settled' },
    { kind: 'net', method: 'POST', urlContains: '/decode', count: 1 },
    { kind: 'state', store: 'app', path: 'scan.status', equals: 'done' },
  ],
};

const ALLOF_EXPECT = {
  kind: 'allOf',
  predicates: [
    { kind: 'net', method: 'POST', urlContains: '/decode', count: 1 },
    { kind: 'signal', name: 'scan:complete', count: 1 },
    { kind: 'state', store: 'app', path: 'scan.status', equals: 'done' },
  ],
};

const CANONICAL = {
  net: { method: 'POST', urlContains: '/decode', count: 1 },
  signal: 'scan:complete',
  signalCount: 1,
  state: { store: 'app', path: 'scan.status', equals: 'done' },
};

function flowDoc(expect: unknown): Record<string, unknown> {
  return {
    version: FLOW_FILE_VERSION,
    name: 'scan',
    createdAt: 1,
    steps: [
      {
        tool: 'reticle_act',
        anchor: { kind: 'testid', value: 'go' },
        action: 'click',
        expect,
      },
    ],
  };
}

describe('coerceFlowExpect', () => {
  /*
   * This block used to assert FLATTENING: an agent's `allOf` was squashed into the one-slot-per-kind
   * struct a v1 file could hold, and a kind nobody could express was refused outright. A step's
   * expect is a `Predicate` now, so the grammar's job shrank to telling the two shapes apart and
   * letting each through unchanged.
   *
   * Every expectation below flipped for that reason, and the direction is the point: what an agent
   * wrote is what the file holds.
   */
  it('lets a predicate through exactly as the agent wrote it', () => {
    const coerced = coerceFlowExpect(ALLOF_EXPECT);
    expect(coerced).toEqual({ ok: true, value: ALLOF_EXPECT });
    expect(FlowFileSchema.safeParse(flowDoc(coerced.ok ? coerced.value : {})).success).toBe(true);
  });

  it('lets a single kind-tagged predicate through unchanged', () => {
    const one = { kind: 'net', method: 'POST', urlContains: '/decode', count: 1 };
    expect(coerceFlowExpect(one)).toEqual({ ok: true, value: one });
  });

  it('still accepts a v1 flat expect, which the schema lifts on read', () => {
    expect(coerceFlowExpect({ signal: 'scan:complete', signalCount: 1 })).toEqual({
      ok: true,
      value: { signal: 'scan:complete', signalCount: 1 },
    });
  });

  it('flattens a v1 sibling-channel expect whose signal is { name, count }', () => {
    expect(coerceFlowExpect(REPORTER_EXPECT)).toEqual({ ok: true, value: CANONICAL });
  });

  /*
   * `{ kind: 'settled' }` used to be REFUSED, because a settle gate is a wait rather than a claim
   * and the flat struct had no slot for one — so saving it would have graded the flow `asserted`
   * while nothing could fail. A predicate holds it now, and `flowExpectHasConsequence` reads the
   * kinds rather than the slots, so a settle-only expect saves and grades as asserting nothing.
   * The refusal was protecting the grade; the grade protects itself.
   */
  it('accepts a settle gate, which now grades as asserting nothing rather than being refused', () => {
    expect(coerceFlowExpect({ kind: 'settled' })).toEqual({
      ok: true,
      value: { kind: 'settled' },
    });
    expect(flowExpectHasConsequence({ kind: 'settled' })).toBe(false);
  });
});

describe('parseFlowFileText', () => {
  it("loads the reporter's three-channel expect instead of calling it malformed", () => {
    const parsed = parseFlowFileText(JSON.stringify(flowDoc(REPORTER_EXPECT)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected ok');
    // Lifted from v1 on read: the file said `{ net, signal, state }` and the value is the predicate
    // tree that means the same thing.
    expect(parsed.value.steps[0]?.expect).toEqual(LIFTED_REPORTER);
  });

  it('loads an allOf expect exactly as it was written', () => {
    const parsed = parseFlowFileText(JSON.stringify(flowDoc(ALLOF_EXPECT)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected ok');
    expect(parsed.value.steps[0]?.expect).toEqual(ALLOF_EXPECT);
  });

  it('says WHY a ref-scoped expect is refused, not only that it is', () => {
    const parsed = parseFlowFileText(
      JSON.stringify(flowDoc({ kind: 'text', contains: 'Error', absent: true, scope: 'e12' })),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected a refusal');
    expect(parsed.detail).toContain('step 0');
    expect(parsed.detail).toContain('text.scope "e12"');
  });

  it('names bad JSON as bad JSON, not as a schema failure', () => {
    const parsed = parseFlowFileText('{not json');
    expect(parsed).toEqual({
      ok: false,
      code: FlowErrorCode.PARSE_FAILED,
      detail: FlowParseNote.NOT_JSON,
    });
  });

  it('names the step and key on an unsupported expect shape', () => {
    const parsed = parseFlowFileText(
      JSON.stringify(flowDoc({ signal: { count: 1 }, net: { method: 'POST' } })),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected parse failure');
    expect(parsed.code).toBe(FlowErrorCode.PARSE_FAILED);
    expect(parsed.detail).toContain(FlowParseNote.UNSUPPORTED_SHAPE);
    expect(parsed.detail).toContain('step 0');
    expect(parsed.detail).toContain('signal');
  });
});

describe('describeFlowZodFailure', () => {
  it('points at the step index and the key the schema could not accept', () => {
    // A v1 expect whose `signal` is an object with no `name`. `flattenSignalObject` leaves it alone
    // precisely so the schema failure can name the key, and the union has to not bury it.
    const result = FlowFileSchema.safeParse(
      flowDoc({ signal: { count: 1 }, net: { method: 'POST' } }),
    );
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected schema failure');
    const detail = describeFlowZodFailure(result.error);
    expect(detail).toContain(FlowParseNote.UNSUPPORTED_SHAPE);
    expect(detail).toContain('step 0');
    expect(detail).toContain('signal');
  });
});

describe('coerceFlowFileExpects', () => {
  it('coerces both step expect and the flow-level success block', () => {
    const coerced = coerceFlowFileExpects({
      ...flowDoc(ALLOF_EXPECT),
      success: { kind: 'signal', name: 'scan:complete' },
    });
    expect(coerced.ok).toBe(true);
    if (!coerced.ok) throw new Error('expected ok');
    const file = coerced.value as { steps: { expect: unknown }[]; success: unknown };
    // Both pass through as written. The coercion's remaining job is the v1 flattening, not a
    // conversion: a predicate is already the shape the file stores.
    expect(file.steps[0]?.expect).toEqual(ALLOF_EXPECT);
    expect(file.success).toEqual({ kind: 'signal', name: 'scan:complete' });
  });
});
