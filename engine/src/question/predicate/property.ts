import { MeasureOp } from 'open-verification';
import { type Delta, type PropertyAssertion } from '@reticlehq/core';

/*
 * The CONTRACT moved to core and is re-exported from here.
 *
 * A saved flow carries a `satisfies` now, so core has to be able to parse one. What stays is the
 * half that DECIDES: `satisfiesProperty`, the baseline it compares against, and the two helpers
 * (`show`, `numberIn`) that exist so a failure can quote what it saw. Core is the contract, this is
 * the reasoning, and the split is the same one `predicate-schema.ts` next door makes.
 */
export { propertyAssertionSchema } from '@reticlehq/core';
export type { Delta, PropertyAssertion } from '@reticlehq/core';

/**
 * Assert a PROPERTY of an observed value rather than its exact bytes.
 *
 * Every predicate this engine had compared for equality, and equality cannot express the one thing
 * a generative feature needs: an app whose output IS a model's output is different on every run and
 * correct on every one of them. `equals: "Paris is the capital of France"` fails the next run for
 * the right answer. "a non-empty string matching /Paris/" holds for every right answer and fails
 * for an empty one, a stack trace, or a spinner that never resolved.
 *
 * DETERMINISM is the discipline, and it is not negotiable. Every property here is decided by this
 * function alone — no model, no network, no clock. "Ask a model whether the output looks right" is
 * the obvious next idea and it is the one that must not be built: it makes the verdict
 * unfalsifiable, which is precisely what `no-fault` exists to name instead of paper over.
 *
 * A failing check always says why. An assertion that reports only `false` sends the reader back for
 * another call to find out what it saw, and that round trip is most of what a verdict costs.
 */

/**
 * The reading taken BEFORE the action, when one was taken.
 *
 * A wrapper rather than a bare value because `undefined` is a legitimate reading — a store path
 * that held nothing — and "the path was empty" and "nobody looked" must not collapse into the same
 * answer. The first is a comparison; the second is a refusal to pretend one happened.
 */
export interface Baseline {
  readonly taken: true;
  readonly value: unknown;
}

export interface PropertyResult {
  readonly ok: boolean;
  /** Why, in the words a reader needs — always present, on pass and on fail. */
  readonly because: string;
  /**
   * Nothing was compared: a relative property was asked with no before-reading.
   *
   * `ok` is false because nothing was proven, but a false nobody could have made true is not a
   * defect in the app, and reporting it as one puts our own gaps into somebody's bug count. The
   * caller lifts this into `inconclusive`.
   */
  readonly unevaluated?: true;
}

/** The relative properties: the ones that mean nothing without a before-reading. */
const RELATIVE: ReadonlySet<string> = new Set(['changed', 'unchanged', 'increased', 'decreased']);

/**
 * A number out of a reading, or undefined.
 *
 * A displayed total arrives as text — `"$1,234.50"` is a number to every reader of the page, and
 * refusing it would make the one assertion this feature exists for unwritable against the DOM. The
 * strip is deliberately narrow: currency symbols, thousands separators and surrounding space. A
 * reading with no digits in it ("sold out", "—", an empty box) is NOT zero, and coercing it to zero
 * is how "the balance went to nothing" reads as a pass.
 */
function numberIn(value: unknown): number | undefined {
  if ('number' === typeof value) return Number.isFinite(value) ? value : undefined;
  if ('string' !== typeof value) return undefined;
  const stripped = value.replace(/[^0-9eE+.-]/g, '');
  if (!/[0-9]/.test(stripped)) return undefined;
  const parsed = Number(stripped);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Structural equality, so two readings of the same object are the same reading. */
function sameReading(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if ('object' !== typeof a || 'object' !== typeof b || null === a || null === b) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** Does a movement of `delta` satisfy the named bound? Tolerance widens, never narrows. */
function withinDelta(moved: number, by: Delta): boolean {
  const tolerance = by.tolerance ?? 0;
  switch (by.op) {
    case MeasureOp.EQUALS:
      return Math.abs(moved - by.value) <= tolerance;
    case MeasureOp.AT_LEAST:
      return moved >= by.value - tolerance;
    case MeasureOp.AT_MOST:
      return moved <= by.value + tolerance;
  }
}

function describeDelta(by: Delta): string {
  const tolerance = by.tolerance ?? 0;
  const band = 0 === tolerance ? '' : ` (± ${String(tolerance)})`;
  return `${by.op} ${String(by.value)}${band}`;
}

/**
 * `increased`/`decreased`, which are the same question with the sign flipped.
 *
 * Both readings must be numbers. A non-numeric one is reported as such rather than compared,
 * because "not a number" is a fact about the reading and `false` would be a claim about the app.
 */
function movedBy(
  value: unknown,
  previous: unknown,
  direction: 'increased' | 'decreased',
  by: Delta | undefined,
): PropertyResult {
  const now = numberIn(value);
  const then = numberIn(previous);
  if (now === undefined || then === undefined) {
    const which = now === undefined ? show(value) : show(previous);
    return {
      ok: false,
      because: `${which} is not a number, so nothing was subtracted — assert the value that carries the total, not the label around it`,
      unevaluated: true,
    };
  }
  const moved = 'increased' === direction ? now - then : then - now;
  const movement = `${show(previous)} → ${show(value)} (${'increased' === direction ? '+' : '-'}${String(Math.abs(moved))})`;
  if (moved <= 0) {
    return { ok: false, because: `expected it to have ${direction}: ${movement}` };
  }
  if (by === undefined) return { ok: true, because: movement };
  const ok = withinDelta(moved, by);
  if (ok) return { ok, because: `${movement}, which is ${describeDelta(by)}` };
  return {
    ok,
    // The float trap, named where it is hit. `100 - 88.13` is 11.870000000000005, so an exact
    // `decreased by 11.87` — the assertion this feature exists for — misses by 5e-15 and reads as a
    // money bug. The tolerance is the fix and the protocol already carries it; a silent epsilon here
    // would be this engine quietly disagreeing with the vocabulary it borrowed.
    because:
      `${movement}, and the change was required to be ${describeDelta(by)}` +
      (MeasureOp.EQUALS === by.op && Math.abs(moved - by.value) < 1e-6
        ? ' — off by less than a millionth, which is floating point, not the app. Give the assertion a `tolerance`'
        : ''),
  };
}

/**
 * A short, readable rendering of any observed value.
 *
 * Never `String(value)` on an unknown: an object stringifies to `[object Object]`, which tells the
 * reader nothing and looks like a real reading. A value JSON cannot encode (a cycle, a BigInt, a
 * function) is named by its TYPE instead, because "cyclic object" is a fact and "[object Object]"
 * is noise wearing the shape of one.
 */
const show = (value: unknown): string => {
  if (undefined === value) return 'undefined';
  if (null === value) return 'null';
  if ('string' === typeof value) return JSON.stringify(value).slice(0, 80);
  if ('number' === typeof value || 'boolean' === typeof value || 'bigint' === typeof value) {
    return String(value);
  }
  try {
    const encoded = JSON.stringify(value);
    return undefined === encoded ? `<${typeof value}>` : encoded.slice(0, 80);
  } catch {
    return Array.isArray(value) ? '<cyclic array>' : '<cyclic object>';
  }
};

function isNonEmpty(value: unknown): boolean {
  if (null === value || undefined === value) return false;
  if ('string' === typeof value) return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if ('object' === typeof value) return Object.keys(value).length > 0;
  // A number or boolean is a value that exists; 0 and false are not "empty".
  return true;
}

function typeOf(value: unknown): string {
  if (null === value) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function satisfiesProperty(
  value: unknown,
  assertion: PropertyAssertion,
  /** The reading taken before the action. Only the relative properties look at it. */
  baseline?: Baseline,
): PropertyResult {
  if (RELATIVE.has(assertion.property) && baseline === undefined) {
    return {
      ok: false,
      because: `'${assertion.property}' compares this reading with the one before the action, and no before-reading was taken — nothing was compared`,
      unevaluated: true,
    };
  }
  const previous = baseline?.value;
  switch (assertion.property) {
    case 'unchanged': {
      const ok = sameReading(previous, value);
      return {
        ok,
        because: ok
          ? `still ${show(value)}`
          : `was ${show(previous)} and is now ${show(value)} — it was required to hold its value`,
      };
    }
    case 'changed': {
      const ok = !sameReading(previous, value);
      return {
        ok,
        because: ok
          ? `${show(previous)} → ${show(value)}`
          : `still ${show(value)} — nothing changed it`,
      };
    }
    case 'increased':
    case 'decreased':
      return movedBy(value, previous, assertion.property, assertion.by);
    case 'nonEmpty': {
      const ok = isNonEmpty(value);
      return {
        ok,
        because: ok
          ? `produced ${typeOf(value)} ${show(value)}`
          : `expected something, got ${show(value)} — an empty result is the failure mode a generated feature actually has`,
      };
    }
    case 'oneOf': {
      const ok = assertion.values.some((v) => Object.is(v, value));
      return {
        ok,
        because: ok
          ? `${show(value)} is in the allowed set`
          : `${show(value)} is not one of ${show(assertion.values)}`,
      };
    }
    case 'withinTolerance': {
      if ('number' !== typeof value || !Number.isFinite(value)) {
        return {
          ok: false,
          because: `expected a finite number within ${String(assertion.tolerance)} of ${String(assertion.of)}, got ${typeOf(value)} ${show(value)} — not coerced, because "100" and 100 are different answers`,
        };
      }
      const delta = Math.abs(value - assertion.of);
      const ok = delta <= assertion.tolerance;
      return {
        ok,
        because: `${String(value)} is ${String(delta)} from ${String(assertion.of)} (tolerance ${String(assertion.tolerance)})`,
      };
    }
    case 'matchesPattern': {
      let re: RegExp;
      try {
        re = new RegExp(assertion.pattern);
      } catch {
        // Never report a broken check as a real negative: that is the false-green shape in miniature.
        return {
          ok: false,
          because: `"${assertion.pattern}" is not a valid regular expression, so nothing was tested — fix the pattern; this is not a result about the app`,
        };
      }
      const text = 'string' === typeof value ? value : show(value);
      const ok = re.test(text);
      return {
        ok,
        because: ok
          ? `${show(text)} matches /${assertion.pattern}/`
          : `${show(text)} does not match /${assertion.pattern}/`,
      };
    }
    case 'type': {
      const actual = typeOf(value);
      const ok = actual === assertion.is;
      return {
        ok,
        because: ok ? `is ${actual}` : `expected ${assertion.is}, got ${actual} ${show(value)}`,
      };
    }
  }
}

/**
 * The wire shape of a property assertion.
 *
 * Lives here beside the evaluator on purpose: a schema in one file and the switch that consumes it
 * in another is how a new property comes to parse and then silently never match.
 */
