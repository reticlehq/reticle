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
  { mutators: ['set', 'reorderSections', 'addSection'], signalCallee: 'reticleSignal' },
];

ruleTester.run(RULE_NAME, requireSignalOnMutation, {
  valid: [
    // mutator + signal in same fn
    {
      code: `function commit(){ set(x); reticleSignal('s'); }`,
      options: OPTS,
    },
    // arrow with mutator + signal
    {
      code: `const f = () => { reorderSections(a, b); reticleSignal('r'); };`,
      options: OPTS,
    },
    // fn calls neither mutator nor signal
    {
      code: `function noop(){ doThing(); compute(); }`,
      options: OPTS,
    },
    // signal-only fn (no mutator)
    {
      code: `function f(){ reticleSignal('x'); }`,
      options: OPTS,
    },
    // custom signalCallee respected
    {
      code: `function f(){ set(1); emitReticle('x'); }`,
      options: [{ mutators: ['set'], signalCallee: 'emitReticle' }],
    },
    // member-expression mutator paired with signal
    {
      code: `function f(){ this.set(1); reticleSignal('x'); }`,
      options: OPTS,
    },
    // no options -> empty default mutators -> no-op, no crash
    {
      code: `function f(){ set(1); }`,
    },
    // default signalCallee 'signal' credits when no signalCallee option
    {
      code: `function f(){ set(1); signal('x'); }`,
      options: [{ mutators: ['set'] }],
    },
    // nested — signal in inner fn satisfies inner mutator
    {
      code: `function outer(){ function inner(){ set(1); reticleSignal('x'); } }`,
      options: OPTS,
    },
  ],
  invalid: [
    // mutator with NO signal -> 1 error, loc on the `set` call
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
    // arrow mutator no signal
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
    // member-expression mutator no signal -> matched by name
    {
      code: `function f(){ store.set(1); }`,
      options: OPTS,
      errors: [{ messageId: MessageId.MUTATION_WITHOUT_SIGNAL }],
    },
    // this.method mutator no signal -> matched
    {
      code: `function f(){ this.reorderSections(a, b); }`,
      options: OPTS,
      errors: [{ messageId: MessageId.MUTATION_WITHOUT_SIGNAL }],
    },
    // nested — mutator in inner, signal only in OUTER -> inner reported
    {
      code: `function outer(){ reticleSignal('x'); function inner(){ set(1); } }`,
      options: OPTS,
      errors: [
        {
          messageId: MessageId.MUTATION_WITHOUT_SIGNAL,
          line: 1,
          column: 57,
        },
      ],
    },
    // nested — mutator in OUTER, signal only in inner -> outer reported
    {
      code: `function outer(){ set(1); (function inner(){ reticleSignal('x'); })(); }`,
      options: OPTS,
      errors: [
        {
          messageId: MessageId.MUTATION_WITHOUT_SIGNAL,
          line: 1,
          column: 19,
        },
      ],
    },
    // two unpaired mutators in two sibling fns -> 2 errors
    {
      code: `function a(){ set(1); } function b(){ addSection({}); }`,
      options: OPTS,
      errors: [
        { messageId: MessageId.MUTATION_WITHOUT_SIGNAL },
        { messageId: MessageId.MUTATION_WITHOUT_SIGNAL },
      ],
    },
    // custom signalCallee — configured callee absent -> error
    {
      code: `function f(){ set(1); reticleSignal('x'); }`,
      options: [{ mutators: ['set'], signalCallee: 'emitReticle' }],
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
    const n = normalizeOptions({ mutators: ['set'], signalCallee: 'emitReticle' });
    expect([...n.mutators]).toEqual(['set']);
    expect([...n.signalCallees]).toEqual(['emitReticle']);
  });

  it('array signalCallee preserved; empty strings dropped', () => {
    const n = normalizeOptions({ mutators: ['set', ''], signalCallee: ['a', '', 'b'] });
    expect([...n.mutators]).toEqual(['set']);
    expect([...n.signalCallees]).toEqual(['a', 'b']);
  });
});

// ── Characterizing the sharp edge of bare-name matching ─────────────────────────────────────────
//
// NOT a bug report: `DEFAULT_MUTATORS` is empty, so the rule is a no-op until someone configures it,
// and matching by name while ignoring the object is deliberate and documented.
//
// It is pinned because the consequence is easy to meet and easy to forget. `set` is zustand's
// mutator and the README's own example entry, and it also matches every `Map`, `Set`,
// `URLSearchParams` and `Headers` call in the same file — a function that only builds a lookup Map
// is reported as an unsignalled mutation. These cases fix that behaviour in place so any future
// change to it is a decision rather than an accident, and the README now warns where users meet it.
const REALISTIC: [{ mutators: string[]; signalCallee: string }] = [
  { mutators: ['set', 'setState'], signalCallee: 'reticleSignal' },
];

ruleTester.run(`${RULE_NAME} (ordinary code)`, requireSignalOnMutation, {
  valid: [],
  invalid: [
    {
      code: `function group(rows){ const by = new Map(); for (const r of rows) by.set(r.id, r); return by; }`,
      options: REALISTIC,
      errors: [{ messageId: MessageId.MUTATION_WITHOUT_SIGNAL }],
    },
    {
      code: `function withPage(u, p){ const url = new URL(u); url.searchParams.set('page', p); return url; }`,
      options: REALISTIC,
      errors: [{ messageId: MessageId.MUTATION_WITHOUT_SIGNAL }],
    },
  ],
});
