/**
 * The `compare` predicate: read two observed values and relate them (see core's compare-source.ts).
 *
 * Each side resolves to one SCALAR or to a result that says why it could not. The honesty rules are
 * the ones every body clause already keeps: a call that never happened, a missing element or a
 * missing field is a failure, because the app did not produce what was claimed; a body that was not
 * recorded, was truncated before the field, or had the field redacted is UNKNOWN, because nobody
 * could have read it. Neither is ever a pass, since a comparison with a side missing compares nothing.
 */
import {
  CompareAs,
  EventType,
  NetBodySide,
  PredicateKind,
  REDACTED_VALUE,
  urlForMatch,
  type ReticleEvent,
} from '@reticlehq/core';
import {
  clipBody,
  parseJsonObject,
  readField,
  redactedOnPath,
  str,
  type EvalResult,
} from './predicate-eval-kit.js';
import type { Predicate } from './predicate-schema.js';
import type { PredicateSession } from './predicate-session.js';
import { evalElement, wholeTextOf } from './predicate-element.js';
import { evalState } from './predicate-state.js';

type ComparePredicate = Extract<Predicate, { kind: typeof PredicateKind.COMPARE }>;
/** Derived from the predicate rather than imported: one fewer name borrowed from core. */
type CompareSource = ComparePredicate['left'];
type Scalar = string | number | boolean | null;

/**
 * One side, read: its value, how to name it and, when the value is too long to quote, the bounded
 * slice that is quoted in its place; or the result that ends the comparison.
 */
type Reading = { value: Scalar; label: string; shown?: Scalar } | { result: EvalResult };

/** What a verdict quotes of a reading: the slice when there is one, the value as it is otherwise. */
function quoted(reading: { value: Scalar; shown?: Scalar }): Scalar {
  return reading.shown ?? reading.value;
}

const REMEDY_BODY_CAPTURE =
  'enable it where the app calls connect(): reticle({ captureNetworkBodies: true })';

function unknown(reason: string): { result: EvalResult } {
  return { result: { pass: false, failureReason: reason, inconclusive: reason } };
}

function missing(reason: string, expected: string): { result: EvalResult } {
  return {
    result: {
      pass: false,
      failureReason: reason,
      observed: reason,
      expected,
      assertion: 'compare.source-missing',
    },
  };
}

function isScalar(value: unknown): value is Scalar {
  return (
    null === value ||
    'string' === typeof value ||
    'number' === typeof value ||
    'boolean' === typeof value
  );
}

function redacted(label: string): { result: EvalResult } {
  return unknown(
    `${label} was ${REDACTED_VALUE} before it was recorded — a redacted field is unknown, not different`,
  );
}

/**
 * A reading that is an object or an array cannot be compared as one value, and neither can the
 * redaction marker: the transport writes it for every sensitive key whatever it held, so two
 * different secrets arrive as the same string and would compare equal.
 */
function asScalar(value: unknown, label: string): Reading {
  if (REDACTED_VALUE === value) return redacted(label);
  if (isScalar(value)) return { value, label };
  return unknown(
    `${label} is ${Array.isArray(value) ? 'an array' : 'an object'}, not a single value — point the path at one field inside it`,
  );
}

function describeNetSource(
  source: Extract<CompareSource, { from: typeof PredicateKind.NET }>,
): string {
  const side = source.body ?? NetBodySide.RESPONSE;
  const call = `${source.method === undefined ? '' : `${source.method.toUpperCase()} `}${source.urlContains}`;
  return `${side} body of the last call to ${call} at ${JSON.stringify(source.path)}`;
}

function readNet(
  events: readonly ReticleEvent[],
  source: Extract<CompareSource, { from: typeof PredicateKind.NET }>,
): Reading {
  const label = describeNetSource(source);
  const calls = events.filter(
    (e) =>
      e.type === EventType.NET_REQUEST &&
      urlForMatch(e.data).includes(source.urlContains) &&
      (source.method === undefined ||
        str(e.data['method'])?.toUpperCase() === source.method.toUpperCase()),
  );
  // The last call is the answer the page would be showing: an earlier one has been superseded by it.
  const call = calls[calls.length - 1];
  if (call === undefined) {
    return missing(
      `no call to ${source.urlContains} in this window, so there was no ${label}`,
      `a call matching ${source.urlContains}`,
    );
  }
  const request = NetBodySide.REQUEST === source.body;
  const body = str(call.data[request ? 'requestBody' : 'responseBody']);
  if (body === undefined) {
    return unknown(
      `the ${label} was not recorded, so it could not be read — ${REMEDY_BODY_CAPTURE}`,
    );
  }
  const truncated = true === call.data[request ? 'requestBodyTruncated' : 'responseBodyTruncated'];
  const payload = parseJsonObject(body);
  if (payload === undefined) {
    return truncated
      ? unknown(`the ${label} was TRUNCATED before it was recorded, so the field could not be read`)
      : unknown(
          `the body is not a JSON object, so ${label} names no field — compare reads JSON fields`,
        );
  }
  if (redactedOnPath(payload, source.path)) return redacted(label);
  const field = readField(payload, source.path);
  if (!field.found) {
    if (truncated) {
      return unknown(
        `the ${label} was TRUNCATED before it was recorded, and the field is not in the part that was kept`,
      );
    }
    const keys = field.availableKeys ?? [];
    return missing(
      `${label} is missing${0 === keys.length ? '' : ` (keys there: ${keys.join(', ')})`}`,
      `a field at ${JSON.stringify(source.path)}`,
    );
  }
  return asScalar(field.value, label);
}

function readSignal(
  events: readonly ReticleEvent[],
  source: Extract<CompareSource, { from: typeof PredicateKind.SIGNAL }>,
): Reading {
  const label = `payload of the last '${source.name}' signal at ${JSON.stringify(source.path)}`;
  const fired = events.filter(
    (e) => e.type === EventType.SIGNAL && str(e.data['name']) === source.name,
  );
  const last = fired[fired.length - 1];
  if (last === undefined) {
    return missing(`signal '${source.name}' never fired in this window`, `signal '${source.name}'`);
  }
  const payload = last.data['data'];
  const record =
    'object' === typeof payload && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : undefined;
  // Signal payloads cross the same transport sanitizer as state, so a parent can be redacted too.
  if (record !== undefined && redactedOnPath(record, source.path)) return redacted(label);
  const field =
    record === undefined ? { found: false, value: undefined } : readField(record, source.path);
  if (!field.found) {
    return missing(`${label} is missing; the payload was ${JSON.stringify(payload)}`, label);
  }
  return asScalar(field.value, label);
}

async function readStore(
  session: PredicateSession,
  source: Extract<CompareSource, { from: typeof PredicateKind.STATE }>,
): Promise<Reading> {
  const label = `state at ${JSON.stringify(source.path)}`;
  const read = await evalState(session, {
    kind: PredicateKind.STATE,
    path: source.path,
    ...(source.store === undefined ? {} : { store: source.store }),
  });
  if (!read.pass) return { result: read };
  const value = (read.evidence as { value?: unknown } | undefined)?.value;
  return asScalar(value, label);
}

async function readText(
  session: PredicateSession,
  source: Extract<CompareSource, { from: typeof PredicateKind.TEXT }>,
  diagnose: boolean,
): Promise<Reading> {
  const label = `text of ${source.scope}`;
  // Read in full: two texts that differ only past the display form's 80 characters would otherwise
  // compare equal, and the equality would be a verdict on a string the page never showed.
  const found = await evalElement(
    session,
    { scope: source.scope, self: true },
    undefined,
    false,
    diagnose,
    true,
  );
  if (!found.pass) return { result: found };
  const whole = wholeTextOf(found.evidence, source.scope, 'the comparison');
  if ('result' in whole) return whole;
  return { value: whole.text, label, shown: clipBody(whole.text) };
}

function readSide(
  session: PredicateSession,
  events: readonly ReticleEvent[],
  source: CompareSource,
  diagnose: boolean,
): Promise<Reading> | Reading {
  switch (source.from) {
    case PredicateKind.NET:
      return readNet(events, source);
    case PredicateKind.SIGNAL:
      return readSignal(events, source);
    case PredicateKind.STATE:
      return readStore(session, source);
    case PredicateKind.TEXT:
      return readText(session, source, diagnose);
  }
}

/**
 * A thousands-grouped number or a plain one, optionally preceded by a minus sign and/or a currency
 * symbol (`-$100`, `-₹1,187.01`). A comma counts as a separator only in groups of three, so `11,87`
 * (a decimal comma) reads as two numbers, not as 1187 — and two numbers are refused.
 */
const NUMBER_TOKEN = /(?:-(?:[\p{Sc}]\s*)?|[\p{Sc}]\s*-?)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/gu;

/** One number out of a reading, or why there is not exactly one. */
function numberOf(reading: { value: Scalar; shown?: Scalar }): { n: number } | { why: string } {
  const { value } = reading;
  if ('number' === typeof value)
    return Number.isFinite(value) ? { n: value } : { why: 'is not finite' };
  if ('string' !== typeof value) return { why: `is ${JSON.stringify(value)}, not a number` };
  const tokens = value.match(NUMBER_TOKEN) ?? [];
  const [only] = tokens;
  if (1 !== tokens.length || only === undefined) {
    return {
      why: `holds ${String(tokens.length)} numbers in ${JSON.stringify(quoted(reading))}, so which one was meant is a guess — narrow the scope to one value`,
    };
  }
  const isNegative = only.includes('-');
  const cleaned = only.replace(/,/g, '');
  const digits = cleaned.match(/(?:\d+(?:\.\d+)?)/);
  if (null === digits) {
    return { why: `could not parse a number from ${JSON.stringify(value)}` };
  }
  const parsed = Number(digits[0]);
  const n = isNegative && 0 !== parsed ? -parsed : parsed;
  return { n };
}

/**
 * A few units in the last place: the noise of arithmetic done in binary (`0.1 + 0.2` against the
 * `0.3` a page prints). Relative to the operands, so it stays below one part in 10^15 — two distinct
 * decimals of 15 significant digits never fall inside it, which is every amount a double can hold
 * to the cent. A fixed relative allowance like 1e-9 made 1,000,000,000 equal 1,000,000,001.
 */
const LAST_PLACE_NOISE = 2 * Number.EPSILON;

function closeEnough(a: number, b: number, tolerance: number): boolean {
  if (a === b) return true;
  return Math.abs(a - b) <= tolerance + LAST_PLACE_NOISE * Math.max(Math.abs(a), Math.abs(b));
}

function describe(reading: { value: Scalar; label: string; shown?: Scalar }): string {
  return `${reading.label} is ${JSON.stringify(quoted(reading))}`;
}

export async function evalCompare(
  session: PredicateSession,
  events: readonly ReticleEvent[],
  p: ComparePredicate,
  diagnose: boolean,
): Promise<EvalResult> {
  const [left, right] = await Promise.all([
    readSide(session, events, p.left, diagnose),
    readSide(session, events, p.right, diagnose),
  ]);
  // A side nobody could read (unknown) outranks one that was read and missing: the unreadable one
  // might have been the answer. Otherwise the first side that did not resolve is the failure.
  if ('result' in left || 'result' in right) {
    const results = [left, right].flatMap((r) => ('result' in r ? [r.result] : []));
    return results.find((r) => r.inconclusive !== undefined) ?? results[0] ?? { pass: false };
  }
  const evidence = {
    left: { source: left.label, value: quoted(left) },
    right: { source: right.label, value: quoted(right) },
  };
  if (CompareAs.NUMBER === p.as) {
    const a = numberOf(left);
    const b = numberOf(right);
    if ('why' in a || 'why' in b) {
      const why =
        'why' in a ? `${left.label} ${a.why}` : `${right.label} ${'why' in b ? b.why : ''}`;
      return { pass: false, failureReason: why, inconclusive: why, evidence };
    }
    const tolerance = p.tolerance ?? 0;
    if (closeEnough(a.n, b.n, tolerance)) return { pass: true, evidence };
    const band = 0 === tolerance ? '' : ` (tolerance ${String(tolerance)})`;
    return {
      pass: false,
      failureReason: `${describe(left)} → ${String(a.n)}, but ${describe(right)} → ${String(b.n)}${band} — they differ`,
      observed: `${String(a.n)} against ${String(b.n)}`,
      expected: `the two numbers to agree${band}`,
      assertion: 'compare.number',
      evidence,
    };
  }
  if (left.value === right.value) return { pass: true, evidence };
  const numeric = numberOf(left);
  const other = numberOf(right);
  const hint =
    'n' in numeric && 'n' in other && closeEnough(numeric.n, other.n, 0)
      ? ' — they hold the same number in different forms; compare them with `as: "number"`'
      : '';
  // Two long texts that differ only past what is quoted would read as equal in the message that says
  // they are not, so say where the difference is.
  const unquoted =
    quoted(left) === quoted(right)
      ? ' — they agree on the part quoted here and differ further on'
      : '';
  return {
    pass: false,
    failureReason: `${describe(left)}, but ${describe(right)}${hint}${unquoted}`,
    observed: `${JSON.stringify(quoted(left))} against ${JSON.stringify(quoted(right))}`,
    expected: 'the two values to be equal',
    assertion: 'compare.value',
    evidence,
  };
}
