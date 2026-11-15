/**
 * The page checks a command and an element query without zod (`page-parse.ts`), so that zod stays
 * off the SDK's first load (#2369). The zod schemas stay the definitions. These tests drive both
 * with generated input and fail when they give different answers, so the two cannot drift.
 */

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { CommandMessageSchema } from './messages.js';
import { ElementQuerySchema } from './types.js';
import {
  CommandActor,
  MAX_OUTWARD_ALLOWED,
  parseCommandMessage,
  parseElementQuery,
} from './page-parse.js';
import { MessageKind, QueryBy, TRANSPORT_LIMITS } from './constants/constants.js';
import { OutwardAction } from '@/verdict/security.js';

const RUNS = 3000;

/** Any value a JSON message could carry, plus the few a hand-built object could. */
const anyValue = fc.oneof(
  fc.string({ maxLength: 4 }),
  fc.integer(),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, 1.5, 0, -1),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.array(fc.string({ maxLength: 3 }), { maxLength: 3 }),
  fc.dictionary(fc.string({ maxLength: 3 }), fc.string({ maxLength: 3 }), { maxKeys: 2 }),
);

/** A string near a length bound: empty, short, at the bound and one past it. */
function nearBound(max: number): fc.Arbitrary<string> {
  return fc.oneof(
    fc.constant(''),
    fc.string({ minLength: 1, maxLength: 6 }),
    fc.constant('a'.repeat(max)),
    fc.constant('a'.repeat(max + 1)),
  );
}

function sometimes<T>(arb: fc.Arbitrary<T>): fc.Arbitrary<unknown> {
  return fc.oneof({ weight: 4, arbitrary: arb }, { weight: 1, arbitrary: anyValue });
}

const commandArb = fc.record(
  {
    kind: sometimes(fc.constantFrom(MessageKind.COMMAND, MessageKind.EVENT)),
    id: sometimes(nearBound(TRANSPORT_LIMITS.MAX_COMMAND_ID_LENGTH)),
    sessionId: sometimes(nearBound(TRANSPORT_LIMITS.MAX_SESSION_ID_LENGTH)),
    name: sometimes(nearBound(TRANSPORT_LIMITS.MAX_COMMAND_NAME_LENGTH)),
    args: sometimes(fc.dictionary(fc.string({ maxLength: 4 }), anyValue, { maxKeys: 3 })),
    by: sometimes(fc.constantFrom(...Object.values(CommandActor), 'agent')),
    outward: sometimes(
      fc.record(
        {
          allowed: sometimes(
            fc.array(fc.constantFrom(...Object.values(OutwardAction), 'launch'), {
              maxLength: MAX_OUTWARD_ALLOWED + 1,
            }),
          ),
          extra: anyValue,
        },
        { requiredKeys: [] },
      ),
    ),
    unknownKey: anyValue,
  },
  { requiredKeys: [] },
);

const queryArb = fc.record(
  {
    by: sometimes(fc.constantFrom(...Object.values(QueryBy), 'xpath')),
    value: sometimes(fc.string({ maxLength: 4 })),
    role: sometimes(fc.string({ maxLength: 4 })),
    name: sometimes(fc.string({ maxLength: 4 })),
    text: sometimes(fc.string({ maxLength: 4 })),
    testid: sometimes(fc.string({ maxLength: 4 })),
    scope: sometimes(fc.string({ maxLength: 4 })),
    attrs: sometimes(fc.array(fc.constantFrom('href', 'src', 'href=x', ''), { maxLength: 3 })),
    source: sometimes(
      fc.record(
        {
          file: sometimes(fc.string({ maxLength: 4 })),
          line: sometimes(fc.integer()),
          column: sometimes(fc.integer()),
          extra: anyValue,
        },
        { requiredKeys: [] },
      ),
    ),
    self: sometimes(fc.boolean()),
    matchCase: sometimes(fc.boolean()),
    unknownKey: anyValue,
  },
  { requiredKeys: [] },
);

describe('the page reads a command as CommandMessageSchema does', () => {
  it('accepts and refuses the same commands, and outputs the same value', () => {
    fc.assert(
      fc.property(fc.oneof(commandArb, anyValue), (input) => {
        const zod = CommandMessageSchema.safeParse(input);
        const page = parseCommandMessage(input);
        expect(page.ok).toBe(zod.success);
        if (page.ok && zod.success) {
          expect(page.value).toStrictEqual(zod.data);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('drops a `__proto__` key in `args`, as zod does, and keeps a plain prototype', () => {
    const input: unknown = JSON.parse(
      '{"kind":"command","id":"1","name":"look","args":{"__proto__":{"polluted":true},"a":1}}',
    );
    const zod = CommandMessageSchema.safeParse(input);
    const page = parseCommandMessage(input);
    expect(page.ok && zod.success).toBe(true);
    if (page.ok && zod.success) {
      expect(page.value).toStrictEqual(zod.data);
      expect(page.value.args).toStrictEqual({ a: 1 });
      expect(Object.getPrototypeOf(page.value.args)).toBe(Object.prototype);
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    }
  });

  it('says why it refused', () => {
    const page = parseCommandMessage({ kind: MessageKind.COMMAND, id: '', name: 'look' });
    expect(page.ok).toBe(false);
    expect(page.ok ? '' : page.error).toContain('`id`');
  });
});

describe('the page reads an element query as ElementQuerySchema does', () => {
  it('accepts and refuses the same queries, and outputs the same value', () => {
    fc.assert(
      fc.property(fc.oneof(queryArb, anyValue), (input) => {
        const zod = ElementQuerySchema.safeParse(input);
        const page = parseElementQuery(input);
        expect(page.ok).toBe(zod.success);
        if (page.ok && zod.success) {
          expect(page.value).toStrictEqual(zod.data);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('refuses a name=value pair in `attrs` and says how to ask instead', () => {
    const page = parseElementQuery({ attrs: ['href=/home'] });
    expect(page.ok).toBe(false);
    expect(page.ok ? '' : page.error).toContain('NAMES only');
  });
});
