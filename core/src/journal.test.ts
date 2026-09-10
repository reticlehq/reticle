import { describe, expect, it } from 'vitest';
import { JOURNAL_FILE_VERSION, JournalActionSchema } from './journal.js';

function action(): Record<string, unknown> {
  return {
    v: JOURNAL_FILE_VERSION,
    actionId: 'c3',
    tool: 'reticle_act',
    tRange: { from: 10, to: 42 },
    at: 10,
  };
}

describe('JournalActionSchema', () => {
  it('narrows a full action record with attribution window and settle', () => {
    const parsed = JournalActionSchema.parse({
      ...action(),
      args: { ref: 'e7' },
      effect: { glyph: 'pass' },
      settled: true,
      settledInMs: 32,
      seqRange: { from: 100, to: 104 },
    });
    expect(parsed.actionId).toBe('c3');
    expect(parsed.seqRange?.to).toBe(104);
    expect(parsed.args).toEqual({ ref: 'e7' });
  });

  it('accepts the minimal record (id + tool + window + timestamp)', () => {
    expect(JournalActionSchema.safeParse(action()).success).toBe(true);
  });

  it('rejects a record from a different schema version', () => {
    expect(JournalActionSchema.safeParse({ ...action(), v: 2 }).success).toBe(false);
  });

  it('rejects a record missing its attribution window', () => {
    const { tRange, ...noWindow } = action();
    void tRange;
    expect(JournalActionSchema.safeParse(noWindow).success).toBe(false);
  });
});
