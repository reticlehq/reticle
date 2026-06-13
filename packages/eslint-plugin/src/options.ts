/** Option schema + normalizer for require-signal-on-mutation. Pure, no I/O. */

import { DEFAULT_MUTATORS, DEFAULT_SIGNAL_CALLEES } from './constants.js';

export interface RawRuleOptions {
  mutators?: string[];
  signalCallee?: string | string[];
}

export interface NormalizedOptions {
  mutators: ReadonlySet<string>;
  signalCallees: ReadonlySet<string>;
}

/** JSON schema for the rule's options[0] (consumed by ESLint meta.schema). */
export const OPTIONS_SCHEMA: readonly unknown[] = [
  {
    type: 'object',
    properties: {
      mutators: {
        type: 'array',
        items: { type: 'string' },
      },
      signalCallee: {
        oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
      },
    },
    additionalProperties: false,
  },
];

function toNonEmptySet(values: readonly string[]): ReadonlySet<string> {
  return new Set(values.filter((v) => v.length > 0));
}

/** Pure: raw options (possibly undefined) -> normalized sets. Injects defaults. */
export function normalizeOptions(raw: RawRuleOptions | undefined): NormalizedOptions {
  const mutatorList = raw?.mutators ?? DEFAULT_MUTATORS;

  const rawSignal = raw?.signalCallee;
  let signalList: readonly string[];
  if (rawSignal === undefined) {
    signalList = DEFAULT_SIGNAL_CALLEES;
  } else if (typeof rawSignal === 'string') {
    signalList = [rawSignal];
  } else {
    signalList = rawSignal;
  }

  return {
    mutators: toNonEmptySet(mutatorList),
    signalCallees: toNonEmptySet(signalList),
  };
}
