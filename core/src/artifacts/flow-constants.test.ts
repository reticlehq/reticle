import { describe, expect, it } from 'vitest';
import { flowJsonReplacer } from './flow-constants.js';

/** A platform on an older core refused every flow carrying `ignoreCase`, even `false`. */
describe('a flow as it is written and sent', () => {
  it('leaves a default ignoreCase out, and keeps a real one', () => {
    const expect_ = {
      kind: 'allOf',
      predicates: [
        { kind: 'text', contains: 'Saved', ignoreCase: false },
        { kind: 'text', contains: 'per project', ignoreCase: true },
      ],
    };
    expect(JSON.parse(JSON.stringify({ steps: [{ expect: expect_ }] }, flowJsonReplacer))).toEqual({
      steps: [
        {
          expect: {
            kind: 'allOf',
            predicates: [
              { kind: 'text', contains: 'Saved' },
              { kind: 'text', contains: 'per project', ignoreCase: true },
            ],
          },
        },
      ],
    });
  });
});
