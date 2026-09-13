import { describe, it, expect } from 'vitest';
import { ChannelId } from '../vocabulary/channel.js';
import { typecheckProgram, TypeErrorKind } from './typecheck.js';

/**
 * The phase that did not exist: refuse a document BEFORE an action is spent.
 *
 * `Realm.perform` already refuses an undeclared capability — at runtime, one action at a time, after
 * the action has been dispatched and the subject has moved. That is the right answer to the wrong
 * question. A flow recorded on a browser and replayed on a realm that cannot swipe should be refused
 * as a DOCUMENT, naming what is missing, rather than discovered halfway through a journey that has
 * already half-happened.
 *
 * It is the protocol's own rule applied to a whole program instead of one claim: *a claim reading a
 * channel that is not here is `unknown` immediately, rather than after the action has been spent.*
 *
 * This is also what makes portability CHECKABLE rather than aspirational. The same source document
 * runs on any realm whose instruction set covers it — and when it does not, the compiler says which
 * capability is missing instead of failing at step 7.
 */
const web = {
  capabilities: ['click', 'type', 'navigate'],
  channels: [ChannelId.UI, ChannelId.NET, ChannelId.STATE],
};

describe('typecheckProgram', () => {
  it('accepts a program whose actions and reads are all declared', () => {
    const errors = typecheckProgram(
      [
        { capability: 'click', reads: [ChannelId.UI] },
        { capability: 'type', reads: [ChannelId.NET] },
      ],
      web,
    );
    expect(errors).toEqual([]);
  });

  it('names the missing CAPABILITY and the step, before anything is dispatched', () => {
    const errors = typecheckProgram([{ capability: 'click' }, { capability: 'swipe' }], web);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe(TypeErrorKind.UNDECLARED_CAPABILITY);
    expect(errors[0]?.step).toBe(1);
    expect(errors[0]?.detail).toContain('swipe');
  });

  it('names a channel the realm does not observe', () => {
    const errors = typecheckProgram([{ capability: 'click', reads: [ChannelId.VISUAL] }], web);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe(TypeErrorKind.UNOBSERVED_CHANNEL);
    expect(errors[0]?.detail).toContain(ChannelId.VISUAL);
  });

  it('reports EVERY problem, not just the first — one pass, one fix list', () => {
    const errors = typecheckProgram(
      [{ capability: 'swipe' }, { capability: 'click', reads: [ChannelId.VISUAL] }],
      web,
    );
    expect(errors).toHaveLength(2);
    expect(errors.map((e) => e.step)).toEqual([0, 1]);
  });

  it('an empty program typechecks — it asserts nothing, which is a coverage question, not a type one', () => {
    expect(typecheckProgram([], web)).toEqual([]);
  });

  it('a realm declaring NOTHING refuses everything, rather than passing vacuously', () => {
    const errors = typecheckProgram([{ capability: 'click' }], { capabilities: [], channels: [] });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe(TypeErrorKind.UNDECLARED_CAPABILITY);
  });
});
