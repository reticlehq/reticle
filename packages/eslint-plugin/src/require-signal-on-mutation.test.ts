import { afterAll, describe, expect, it } from 'vitest';
import { RuleTester } from '@typescript-eslint/rule-tester';
import { requireSignalOnMutation } from './require-signal-on-mutation.js';
import { MessageId, RULE_NAME } from './constants.js';
import { normalizeOptions } from './options.js';
import { DEFAULT_SIGNAL_CALLEES } from './constants.js';

// Wire the typescript-eslint RuleTester to vitest (documented integration).
RuleTester.afterAll = afterAll;
RuleTester.it = it;
RuleTester.itOnly = it.only;
RuleTester.describe = describe;

const ruleTester = new RuleTester();

const OPTS: [{ mutators: string[]; signalCallee: string }] = [
  { mutators: ['set', 'reorderSections', 'addSection'], signalCallee: 'irisSignal' },
];

ruleTester.run(RULE_NAME, requireSignalOnMutation, {
  valid: [
    // V1: mutator + signal in same fn
    {
      code: `function commit(){ set(x); irisSignal('s'); }`,
      options: OPTS,
    },
    // V2: arrow with mutator + signal
    {
      code: `const f = () => { reorderSections(a, b); irisSignal('r'); };`,
      options: OPTS,
    },
    // V3: fn calls neither mutator nor signal
    {
      code: `function noop(){ doThing(); compute(); }`,
      options: OPTS,
    },
    // V4: signal-only fn (no mutator)
    {
      code: `function f(){ irisSignal('x'); }`,
      options: OPTS,
    },
    // V5: custom signalCallee respected
    {
      code: `function f(){ set(1); emitIris('x'); }`,
      options: [{ mutators: ['set'], signalCallee: 'emitIris' }],
    },
    // V6: member-expression mutator paired with signal
    {
      code: `function f(){ this.set(1); irisSignal('x'); }`,
      options: OPTS,
    },
    // V7: no options -> empty default mutators -> no-op, no crash
    {
      code: `function f(){ set(1); }`,
    },
    // V8: default signalCallee 'signal' credits when no signalCallee option
    {
      code: `function f(){ set(1); signal('x'); }`,
      options: [{ mutators: ['set'] }],
    },
    // V9: nested — signal in inner fn satisfies inner mutator
    {
      code: `function outer(){ function inner(){ set(1); irisSignal('x'); } }`,
      options: OPTS,
    },
  ],
  invalid: [
    // I1: mutator with NO signal -> 1 error, loc on the `set` call
    {
      code: `function f(){ set(1); }`,
      options: OPTS,
      errors: [
        {
          messageId: MessageId.MUTATION_WITHOUT_SIGNAL,
          line: 1,
          column: 15,
        },
      ],
    },
    // I2: arrow mutator no signal
    {
      code: `const f = () => { addSection({}); };`,
      options: OPTS,
      errors: [
        {
          messageId: MessageId.MUTATION_WITHOUT_SIGNAL,
          line: 1,
          column: 19,
        },
      ],
    },
    // I3: member-expression mutator no signal -> matched by name
    {
      code: `function f(){ store.set(1); }`,
      options: OPTS,
      errors: [{ messageId: MessageId.MUTATION_WITHOUT_SIGNAL }],
    },
    // I4: this.method mutator no signal -> matched
    {
      code: `function f(){ this.reorderSections(a, b); }`,
      options: OPTS,
      errors: [{ messageId: MessageId.MUTATION_WITHOUT_SIGNAL }],
    },
    // I5: nested — mutator in inner, signal only in OUTER -> inner reported
    {
      code: `function outer(){ irisSignal('x'); function inner(){ set(1); } }`,
      options: OPTS,
      errors: [
        {
          messageId: MessageId.MUTATION_WITHOUT_SIGNAL,
          line: 1,
          column: 54,
        },
      ],
    },
    // I6: nested — mutator in OUTER, signal only in inner -> outer reported
    {
      code: `function outer(){ set(1); (function inner(){ irisSignal('x'); })(); }`,
      options: OPTS,
      errors: [
        {
          messageId: MessageId.MUTATION_WITHOUT_SIGNAL,
          line: 1,
          column: 19,
        },
      ],
    },
    // I7: two unpaired mutators in two sibling fns -> 2 errors
    {
      code: `function a(){ set(1); } function b(){ addSection({}); }`,
      options: OPTS,
      errors: [
        { messageId: MessageId.MUTATION_WITHOUT_SIGNAL },
        { messageId: MessageId.MUTATION_WITHOUT_SIGNAL },
      ],
    },
    // I8: custom signalCallee — configured callee absent -> error
    {
      code: `function f(){ set(1); irisSignal('x'); }`,
      options: [{ mutators: ['set'], signalCallee: 'emitIris' }],
      errors: [{ messageId: MessageId.MUTATION_WITHOUT_SIGNAL }],
    },
  ],
});

describe('normalizeOptions', () => {
  it('undefined -> empty mutators + default signal callees', () => {
    const n = normalizeOptions(undefined);
    expect(n.mutators.size).toBe(0);
    expect([...n.signalCallees].sort()).toEqual([...DEFAULT_SIGNAL_CALLEES].sort());
  });

  it('string signalCallee coerced to a single-element set', () => {
    const n = normalizeOptions({ mutators: ['set'], signalCallee: 'emitIris' });
    expect([...n.mutators]).toEqual(['set']);
    expect([...n.signalCallees]).toEqual(['emitIris']);
  });

  it('array signalCallee preserved; empty strings dropped', () => {
    const n = normalizeOptions({ mutators: ['set', ''], signalCallee: ['a', '', 'b'] });
    expect([...n.mutators]).toEqual(['set']);
    expect([...n.signalCallees]).toEqual(['a', 'b']);
  });
});
