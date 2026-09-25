/**
 * Accept the assertion grammar a drive already uses, in a saved flow file.
 *
 * FlowExpect is a flat object (`signal` is a name string; `net`/`state` sit beside it). Agents write
 * the `act_and_wait` shape instead — `{ kind: "allOf", predicates: [...] }`, or sibling channels
 * with `signal: { name, count }` — and replay answered `flow_parse_failed` / "malformed". That sent
 * people looking for a JSON syntax error in a file they had just written, and the workaround was to
 * drop every channel but one.
 *
 * Coercion happens at load: the on-disk schema does not move, FLOW_FILE_VERSION stays 1, and a
 * re-save writes the canonical shape. A kind a saved flow cannot enforce is refused, not stripped
 * to an empty expect that would grade asserted-while-unchecked.
 */
import {
  FlowExpectSchema,
  FlowPredicateSchema,
  READABLE_FLOW_VERSIONS,
  FlowErrorCode,
  FlowFileSchema,
  type FlowFile,
} from '@reticlehq/core';
import type { ZodError, ZodIssue } from 'zod';
import type { FlowResult } from './flow-result.js';

export const FlowParseNote = {
  NOT_JSON: 'flow file is not valid JSON — fix the syntax or regenerate it with reticle_flow_save',
  MALFORMED: 'flow file is malformed — fix or regenerate it with reticle_flow_save',
  UNSUPPORTED_SHAPE: 'valid JSON, unsupported expect shape',
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return 'object' === typeof value && null !== value && !Array.isArray(value);
}

type CoerceExpectResult = { ok: true; value: unknown } | { ok: false; detail: string };

/**
 * Flatten `signal: { name, count }` into the on-disk fields. Other channels already match FlowExpect.
 * Leave a signal object with no name alone so the schema failure can name the key.
 */
function flattenSignalObject(raw: Record<string, unknown>): Record<string, unknown> {
  const signal = raw['signal'];
  if (!isRecord(signal)) return raw;
  const name = signal['name'];
  if ('string' !== typeof name) return raw;
  const out: Record<string, unknown> = { ...raw, signal: name };
  if ('number' === typeof signal['count']) out['signalCount'] = signal['count'];
  if (undefined !== signal['dataMatches']) out['signalData'] = signal['dataMatches'];
  return out;
}

export function coerceFlowExpect(raw: unknown): CoerceExpectResult {
  if (isRecord(raw) && 'kind' in raw) {
    const parsed = FlowPredicateSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, detail: describePredicateExpectFailure(parsed.error) };
    }
    // Kept AS the predicate. There is nothing to convert to any more, so nothing to refuse for
    // being inexpressible — the shape an agent wrote is the shape the file holds.
    return { ok: true, value: parsed.data };
  }
  if (!isRecord(raw)) return { ok: true, value: raw };
  const flattened = flattenSignalObject(raw);
  /*
   * A v1 expect is validated HERE so a misspelling is named.
   *
   * The schema accepts both formats as a union, and a union rejection reports every branch's
   * complaint at once — so `{ signal: 'x', signl: 'typo' }` came back as "flow file is malformed"
   * without the word `signl` in it. The file was still refused, which is the half that matters, but
   * the reader was left to find a one-character typo by eye. Checking the v1 shape on its own, on
   * the path that already knows this is a v1 expect, puts the key back in the message.
   */
  const asV1 = FlowExpectSchema.safeParse(flattened);
  if (!asV1.success) {
    return { ok: false, detail: describePredicateExpectFailure(asV1.error) };
  }
  return { ok: true, value: flattened };
}

function describePredicateExpectFailure(error: ZodError): string {
  const refused = error.issues.find((one) => 'custom' === one.code);
  if (refused !== undefined) return `${FlowParseNote.UNSUPPORTED_SHAPE}: ${refused.message}`;
  // An unrecognized key FIRST: a strict object reports it on the object's own path with the names
  // in `keys`, so reading `path[0]` misses the one thing worth saying. A misspelling is the failure
  // this whole check exists to catch, and naming it is the difference between a fix and a hunt.
  const unknownKey = error.issues.find((one) => 'unrecognized_keys' === one.code);
  if (unknownKey !== undefined && 'unrecognized_keys' === unknownKey.code) {
    const named = unknownKey.keys.map((k) => `"${k}"`).join(', ');
    return `${FlowParseNote.UNSUPPORTED_SHAPE} key ${named}`;
  }
  const issue = error.issues[0];
  if (undefined === issue) return FlowParseNote.UNSUPPORTED_SHAPE;
  const key = issue.path[0];
  if ('string' === typeof key || 'number' === typeof key) {
    return `${FlowParseNote.UNSUPPORTED_SHAPE} key "${String(key)}"`;
  }
  return FlowParseNote.UNSUPPORTED_SHAPE;
}

export function coerceFlowFileExpects(raw: unknown): CoerceExpectResult {
  if (!isRecord(raw)) return { ok: true, value: raw };
  const next: Record<string, unknown> = { ...raw };
  const stepsIn = next['steps'];
  if (Array.isArray(stepsIn)) {
    const steps: unknown[] = [];
    for (let i = 0; i < stepsIn.length; i++) {
      const step: unknown = stepsIn[i] as unknown;
      if (!isRecord(step) || undefined === step['expect']) {
        steps.push(step);
        continue;
      }
      const coerced = coerceFlowExpect(step['expect']);
      if (!coerced.ok) {
        return {
          ok: false,
          detail: `${FlowParseNote.UNSUPPORTED_SHAPE} at step ${String(i)}: ${coerced.detail}`,
        };
      }
      steps.push({ ...step, expect: coerced.value });
    }
    next['steps'] = steps;
  }
  if (undefined !== next['success']) {
    const coerced = coerceFlowExpect(next['success']);
    if (!coerced.ok) {
      return {
        ok: false,
        detail: `${FlowParseNote.UNSUPPORTED_SHAPE} at success: ${coerced.detail}`,
      };
    }
    next['success'] = coerced.value;
  }
  return { ok: true, value: next };
}

/**
 * The issues a union rejection buries.
 *
 * `expect` accepts a predicate OR a v1 expect, and zod reports a union failure as one
 * `invalid_union` issue whose branch errors live inside `unionErrors`. The one that matters is the
 * v1 branch's `unrecognized_keys` — the misspelled field. Without this the file was still correctly
 * REFUSED and the message said only "malformed", which sends the author back to hunt a
 * one-character typo we had already identified.
 */
function flatten(issues: readonly ZodIssue[]): ZodIssue[] {
  return issues.flatMap((issue) =>
    'invalid_union' === issue.code
      ? [issue, ...flatten(issue.unionErrors.flatMap((e) => e.issues))]
      : [issue],
  );
}

export function describeFlowZodFailure(error: ZodError): string {
  const all = flatten(error.issues);
  /*
   * The most SPECIFIC complaint wins, wherever in the union it was reported.
   *
   * An unrecognized key names the typo. Failing that, an issue whose path reaches INTO an expect
   * names the field that was the wrong type — `{ signal: { count: 1 } }`, a signal object with no
   * name, is reported on `steps.0.expect.signal` and that path is the whole answer. The union's own
   * top-level `invalid_union` says only "malformed", which is true and useless.
   */
  const named = (one: ZodIssue): boolean => {
    // NOT the discriminator complaint. `invalid_union_discriminator` on `expect.kind` is the
    // PREDICATE branch objecting that a v1 expect has no `kind` — which is true of every v1 expect
    // ever written and tells the author nothing. The useful issue is the one from the branch they
    // were actually writing.
    if ('invalid_union_discriminator' === one.code) return false;
    return (
      ('steps' === one.path[0] && 'expect' === one.path[2] && one.path.length > 3) ||
      ('success' === one.path[0] && one.path.length > 1)
    );
  };
  // A refinement carries its own reason (a session ref, named by field), and that reason IS the fix.
  const refused = all.find((one) => 'custom' === one.code);
  if (refused !== undefined && 'steps' === refused.path[0] && 'number' === typeof refused.path[1]) {
    return `${FlowParseNote.UNSUPPORTED_SHAPE} at step ${String(refused.path[1])}: ${refused.message}`;
  }
  if (refused !== undefined) return `${FlowParseNote.UNSUPPORTED_SHAPE}: ${refused.message}`;
  const issue =
    all.find((one) => 'unrecognized_keys' === one.code) ?? all.find(named) ?? error.issues[0];
  if (undefined === issue) return FlowParseNote.MALFORMED;
  const path = issue.path;
  // A strict object reports an unrecognized key as `unrecognized_keys` on the OBJECT's path, with
  // the offending names in `keys` — not as an issue whose path ends in the key. Reading only the
  // path shape reported the one failure this exists to name as a bare "malformed", which sends the
  // author back to the file to find a typo we had already identified.
  if ('unrecognized_keys' === issue.code) {
    const named = issue.keys.map((k) => `"${k}"`).join(', ');
    if ('steps' === path[0] && 'number' === typeof path[1] && 'expect' === path[2]) {
      return `${FlowParseNote.UNSUPPORTED_SHAPE} at step ${String(path[1])} key ${named}`;
    }
    if ('success' === path[0]) return `${FlowParseNote.UNSUPPORTED_SHAPE} at success key ${named}`;
    return `${FlowParseNote.UNSUPPORTED_SHAPE} — unrecognized key ${named}`;
  }
  if (
    'steps' === path[0] &&
    'number' === typeof path[1] &&
    'expect' === path[2] &&
    'string' === typeof path[3]
  ) {
    return `${FlowParseNote.UNSUPPORTED_SHAPE} at step ${String(path[1])} key "${path[3]}"`;
  }
  if ('success' === path[0] && 'string' === typeof path[1]) {
    return `${FlowParseNote.UNSUPPORTED_SHAPE} at success key "${path[1]}"`;
  }
  return FlowParseNote.MALFORMED;
}

export function parseFlowFileText(text: string): FlowResult<FlowFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: FlowErrorCode.PARSE_FAILED, detail: FlowParseNote.NOT_JSON };
  }
  /*
   * Version BEFORE schema. When the format does not match, nothing else in the file can be trusted
   * to mean what this reader thinks it means, so the first unrelated field that happens to fail
   * would be noise about the wrong thing -- and `version` is a `z.literal`, so the schema's own
   * complaint about it is indistinguishable from a typo.
   *
   * Only a NUMBER that is not ours counts. A missing or non-numeric `version` is a damaged field
   * rather than a different format, and stays PARSE_FAILED.
   */
  const declared: unknown = isRecord(parsed) ? parsed['version'] : undefined;
  if ('number' === typeof declared && !READABLE_FLOW_VERSIONS.has(declared)) {
    return {
      ok: false,
      code: FlowErrorCode.WRONG_VERSION,
      detail:
        `this flow file is version ${String(declared)} and this Reticle reads versions ` +
        `${[...READABLE_FLOW_VERSIONS].join(' and ')}. The file is not damaged, the reader is the ` +
        'wrong one. ' +
        'Upgrade or downgrade Reticle rather than editing the flow.',
    };
  }
  const coerced = coerceFlowFileExpects(parsed);
  if (!coerced.ok) {
    return { ok: false, code: FlowErrorCode.PARSE_FAILED, detail: coerced.detail };
  }
  const result = FlowFileSchema.safeParse(coerced.value);
  if (!result.success) {
    return {
      ok: false,
      code: FlowErrorCode.PARSE_FAILED,
      detail: describeFlowZodFailure(result.error),
    };
  }
  return { ok: true, value: result.data };
}
