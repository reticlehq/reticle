/**
 * Computed-style predicate: what the browser resolved, not what the stylesheet said.
 *
 * A design-system change to shared CSS cannot produce a verdict from presence — the class is still
 * on the card. `getComputedStyle` is the cheap, deterministic answer, and the failure has to name
 * the property and both values in the browser's normalised form or the mismatch is unreadable.
 *
 * Split out of `predicate.ts` the same way `predicate-element.ts` was: one round-trip protocol, and
 * a pure matcher that can be tested without a session.
 */

import { PredicateKind, ReticleCommand } from '@reticlehq/core';
import type { EvalResult } from './predicate-eval.js';
import type { Predicate } from './predicate-schema.js';
import type { PredicateSession } from './predicate.js';

export type StylePropertyWanted = string | { contains: string } | { matches: string };

export interface StyleValueMatch {
  readonly pass: boolean;
  readonly observed?: string;
  readonly expected?: string;
  readonly failureReason?: string;
}

const CONTAINS = 'contains';
const MATCHES = 'matches';

function isContains(wanted: StylePropertyWanted): wanted is { contains: string } {
  return 'object' === typeof wanted && CONTAINS in wanted;
}

function isMatches(wanted: StylePropertyWanted): wanted is { matches: string } {
  return 'object' === typeof wanted && MATCHES in wanted;
}

/**
 * Compare one computed value to the claim. Exact for colors; contains/regex for compound values
 * (`box-shadow`, `font-family`) whose normalised form is a list the caller cannot reasonably retype.
 */
export function matchStyleValue(actual: string, wanted: StylePropertyWanted): StyleValueMatch {
  const observed = actual.trim();
  if (isContains(wanted)) {
    const needle = wanted.contains;
    if (observed.includes(needle)) return { pass: true };
    return {
      pass: false,
      observed,
      expected: `a computed value containing '${needle}'`,
      failureReason: `computed style is ${JSON.stringify(observed)}, expected to contain ${JSON.stringify(needle)}`,
    };
  }
  if (isMatches(wanted)) {
    const source = wanted.matches;
    let re: RegExp;
    try {
      re = new RegExp(source);
    } catch {
      return {
        pass: false,
        observed,
        expected: `a usable regex ${JSON.stringify(source)}`,
        failureReason: `style.matches is not a usable regex: ${JSON.stringify(source)}`,
      };
    }
    if (re.test(observed)) return { pass: true };
    return {
      pass: false,
      observed,
      expected: `a computed value matching /${source}/`,
      failureReason: `computed style is ${JSON.stringify(observed)}, expected to match /${source}/`,
    };
  }
  const expected = wanted.trim();
  if (observed === expected) return { pass: true };
  return {
    pass: false,
    observed,
    expected,
    failureReason: `computed style is ${JSON.stringify(observed)}, expected ${JSON.stringify(expected)}`,
  };
}

type StylePredicate = Extract<Predicate, { kind: typeof PredicateKind.STYLE }>;

interface ComputedStyleResult {
  readonly matched?: unknown;
  readonly count?: unknown;
  readonly styles?: unknown;
  readonly invalidSelector?: unknown;
}

function asStyles(value: unknown): Record<string, string> {
  if ('object' !== typeof value || null === value) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if ('string' === typeof raw) out[key] = raw;
  }
  return out;
}

export async function evalStyle(
  session: PredicateSession,
  predicate: StylePredicate,
): Promise<EvalResult> {
  const css = predicate.query.css;
  const names = Object.keys(predicate.properties);
  const res = await session.command(ReticleCommand.COMPUTED_STYLE, {
    css,
    properties: names,
  });
  const subject = JSON.stringify({ css });
  if (!res.ok) {
    const reason = `could not read computed style for ${subject}`;
    return { pass: false, failureReason: reason, inconclusive: reason };
  }
  const result = (res.result ?? {}) as ComputedStyleResult;
  if (true === result.invalidSelector) {
    return {
      pass: false,
      failureReason: `${css} is not a usable CSS selector`,
      observed: 'the selector did not parse',
      expected: `an element matching ${subject}`,
      assertion: 'style.query',
    };
  }
  if (true !== result.matched) {
    return {
      pass: false,
      failureReason: `no element matched ${subject}`,
      observed: 'no matching element on the page',
      expected: `an element matching ${subject}`,
      assertion: 'style.present',
    };
  }
  const styles = asStyles(result.styles);
  for (const name of names) {
    const wanted = predicate.properties[name];
    if (undefined === wanted) continue;
    const verdict = matchStyleValue(styles[name] ?? '', wanted);
    if (verdict.pass) continue;
    return {
      pass: false,
      failureReason: `${name}: ${verdict.failureReason ?? 'computed style did not match'}`,
      observed: `${name} = ${JSON.stringify(verdict.observed ?? '')}`,
      expected: `${name} = ${JSON.stringify(verdict.expected ?? '')}`,
      assertion: `style.${name}`,
      evidence: { css, count: result.count, styles },
    };
  }
  return { pass: true, evidence: { css, count: result.count, styles } };
}
