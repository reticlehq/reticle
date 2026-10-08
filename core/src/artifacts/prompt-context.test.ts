import { describe, expect, it } from 'vitest';
import {
  StatementKind,
  classifyStatement,
  shareableRun,
  splitStatements,
} from './prompt-context.js';

describe('the prompt context of a verification', () => {
  it('tells a goal, a check, a constraint and a preference apart', () => {
    expect(classifyStatement('Customers can reorder a past purchase')).toBe(
      StatementKind.BUSINESS_INTENT,
    );
    expect(classifyStatement('The cart must show the new total')).toBe(StatementKind.ACCEPTANCE);
    expect(classifyStatement('Use the existing Button component from our library')).toBe(
      StatementKind.CONSTRAINT,
    );
    expect(classifyStatement('I prefer the darker header')).toBe(StatementKind.PREFERENCE);
  });

  it('tells the other kinds a prompt carries apart, too', () => {
    const cases: [string, StatementKind][] = [
      ['Refactor the refund hook into its own module', StatementKind.CODING_INTENT],
      ['Fix the bug where the total is off by a cent', StatementKind.CODING_INTENT],
      ['The table should stay usable on mobile', StatementKind.UX_EXPECTATION],
      ['Only admins can issue a refund', StatementKind.SECURITY],
      ["Don't touch the settlements page", StatementKind.OUT_OF_SCOPE],
      ['Merchants get their money back the same day', StatementKind.BUSINESS_INTENT],
    ];
    for (const [text, kind] of cases) expect(classifyStatement(text), text).toBe(kind);
  });

  it('splits a request into its sentences', () => {
    expect(splitStatements('Add reorder. It must keep the size!\nKeep it fast')).toEqual([
      'Add reorder.',
      'It must keep the size!',
      'Keep it fast',
    ]);
  });

  it('leaves the machine without its prompt unless the project opted in', () => {
    const run = { runId: 'r', context: { request: 'secret plans', statements: [] } };
    expect(shareableRun(run)).toEqual({ runId: 'r' });
    const shared = { runId: 'r', context: { request: 'ok', statements: [], shared: true } };
    expect(shareableRun(shared)).toBe(shared);
    expect(shareableRun({ runId: 'r' })).toEqual({ runId: 'r' });
  });
});
