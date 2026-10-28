/**
 * One hint when an agent makes the same call, with the same result, for the third time in a row.
 *
 * Agents in the field made the same call five times or more in a row. Each answer was the same, and
 * nothing in it said so. This module remembers the LAST call of each agent connection and gives one
 * line, on the third identical call, that says what to try instead.
 *
 * Advice only: it reads a result that is already decided and never changes or blocks it. A hint says
 * only what the result supports. When there is nothing specific to say, it says that the call was
 * repeated with the same result.
 */
import { createHash } from 'node:crypto';
import { RefusalReason, ReticleTool, isPlainRecord } from '@reticlehq/core';
import { resultIsError } from '@/surface/mcp/faults/mcp-is-error.js';
import { buildErrorPayload, codedRefusalOf, refusalReasonFor } from './error-recovery.js';
import { EnvelopeKey } from './tool-kit.js';
import { NEAREST_TARGETS_LEAD } from './act/resolve-target.js';

/** The call in a streak that gets the hint. Two calls can be a deliberate retry; three is a loop. */
export const REPEAT_HINT_AT = 3;

const COUNT = String(REPEAT_HINT_AT);

export const RepeatHint = {
  NO_MATCH:
    `You made this call ${COUNT} times and each time no element matched. Do not send it again. ` +
    'Take one reticle_look { action: "find" } and use a ref from its answer.',
  /** A no_match whose refusal listed the nearest targets: the retry is one of those refs. */
  noMatchNearest: (ref: string): string =>
    `You made this call ${COUNT} times and each time no element matched. Do not send it again. ` +
    `The refusal lists the nearest targets. Pass one of their refs as \`ref\`, for example "${ref}".`,
  LOOK_SAME:
    `You made this look ${COUNT} times and each answer was the same, so the page did not change. ` +
    'Act on the page, or wait for a change with reticle_assert { action: "wait" }.',
  RECOVERY:
    `You made this call ${COUNT} times and it was refused for the same reason each time. ` +
    'Do the step in `recovery` before you send it again.',
  SAME: `You made this call ${COUNT} times in a row with the same result.`,
  /** A verdict repeated: name its own reason, the only thing the result says about why. */
  verdict: (verified: string, because: string | undefined): string =>
    `You made this call ${COUNT} times and each verdict was "${verified}".` +
    (because === undefined ? '' : ` Its reason: "${because}".`) +
    ' The same call gives the same verdict. Change the target, the action or the `until`.',
} as const;

/** What a call came back with, as far as a repeat is concerned: an identity and the line to say. */
export interface RepeatOutcome {
  readonly id: string;
  readonly hint: string;
}

/**
 * Result keys that change from call to call when nothing else did: the dispatcher's own advisories,
 * the screenshot path, and the clock. A key that is missed here only means no hint fires.
 */
const VOLATILE_KEYS: ReadonlySet<string> = new Set<string>([
  ...Object.values(EnvelopeKey),
  'cursor',
  'since',
  'at',
  'ms',
  'elapsedMs',
  'durationMs',
]);

/** The same JSON for the same value, whatever the key order. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (isPlainRecord(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** A short digest, so a connection keeps a few bytes and not a whole page tree. */
function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** The first ref in a no_match refusal's nearest-target list, or undefined when it has no list. */
function firstNearestRef(message: string): string | undefined {
  const at = message.indexOf(NEAREST_TARGETS_LEAD);
  if (-1 === at) {
    return undefined;
  }
  return /^(\S+) \(/.exec(message.slice(at + NEAREST_TARGETS_LEAD.length))?.[1];
}

function refusal(reason: RefusalReason, recovery: unknown, message: string): RepeatOutcome {
  const id = `refused:${reason}`;
  if (RefusalReason.NO_MATCH === reason) {
    const ref = firstNearestRef(message);
    return { id, hint: ref === undefined ? RepeatHint.NO_MATCH : RepeatHint.noMatchNearest(ref) };
  }
  return { id, hint: 'string' === typeof recovery ? RepeatHint.RECOVERY : RepeatHint.SAME };
}

/** The outcome of a call that threw: its refusal reason. */
export function outcomeOfError(error: unknown): RepeatOutcome {
  const message = error instanceof Error ? error.message : String(error);
  const coded = codedRefusalOf(error);
  return refusal(
    refusalReasonFor(message, coded),
    buildErrorPayload(message, coded).recovery,
    message,
  );
}

/** The outcome of a call that answered: its refusal reason, its verdict, or its whole answer. */
export function outcomeOfResult(tool: string, result: unknown): RepeatOutcome {
  if (!isPlainRecord(result)) {
    return { id: `value:${digest(stableJson(result))}`, hint: RepeatHint.SAME };
  }
  if (resultIsError(result)) {
    const message = String(result['error']);
    return refusal(refusalReasonFor(message), result['recovery'], message);
  }
  if ('verified' in result) {
    const verified = String(result['verified']);
    const because = 'string' === typeof result['because'] ? result['because'] : undefined;
    return {
      id: `verdict:${verified}:${because ?? ''}`,
      hint: RepeatHint.verdict(verified, because),
    };
  }
  const kept = Object.fromEntries(
    Object.entries(result).filter(([key]) => !VOLATILE_KEYS.has(key)),
  );
  return {
    id: `answer:${digest(stableJson(kept))}`,
    hint: ReticleTool.LOOK === tool ? RepeatHint.LOOK_SAME : RepeatHint.SAME,
  };
}

interface Streak {
  readonly call: string;
  readonly outcome: string;
  readonly count: number;
}

/** Bound on remembered connections: a daemon outlives them. Each keeps only its last call. */
const MAX_CONNECTIONS = 500;

const lastByConnection = new Map<string, Streak>();

/** Tests only. */
export function resetRepeatHints(): void {
  lastByConnection.clear();
}

/**
 * Note one call of one connection, and answer the hint when this call is the third in a streak.
 * `owner` is the agent connection; undefined (the Harness, the HUD, an embedding) is never counted.
 */
export function noteRepeat(
  owner: string | undefined,
  tool: string,
  args: Record<string, unknown>,
  outcome: RepeatOutcome,
): string | undefined {
  if (owner === undefined) {
    return undefined;
  }
  const call = digest(`${tool}:${stableJson(args)}`);
  const last = lastByConnection.get(owner);
  const count = last?.call === call && last.outcome === outcome.id ? last.count + 1 : 1;
  // Delete first, so the map order is last use and the oldest connection is the one that goes.
  lastByConnection.delete(owner);
  if (lastByConnection.size >= MAX_CONNECTIONS) {
    const oldest = lastByConnection.keys().next().value;
    if (oldest !== undefined) {
      lastByConnection.delete(oldest);
    }
  }
  lastByConnection.set(owner, { call, outcome: outcome.id, count });
  return REPEAT_HINT_AT === count ? outcome.hint : undefined;
}

/** Hints for calls that threw, kept beside the error so the boundary that answers can read them. */
const hintByError = new WeakMap<object, string>();

/**
 * Run one call of one connection inside its repeat streak. Answers the result and, on the third
 * identical call, the hint. A call that throws keeps its hint beside the error (`withRepeatHint`).
 */
export async function inRepeatStreak(
  owner: string | undefined,
  tool: string,
  args: Record<string, unknown>,
  run: () => Promise<unknown>,
): Promise<{ raw: unknown; hint: string | undefined }> {
  let raw: unknown;
  try {
    raw = await run();
  } catch (error) {
    const hint = noteRepeat(owner, tool, args, outcomeOfError(error));
    if (hint !== undefined && 'object' === typeof error && null !== error) {
      hintByError.set(error, hint);
    }
    throw error;
  }
  return { raw, hint: noteRepeat(owner, tool, args, outcomeOfResult(tool, raw)) };
}

/** The answer with the hint beside it. Extra text only: the verdict and every field stay as they are. */
export function withHintOn(answer: unknown, hint: string | undefined): unknown {
  return hint !== undefined && isPlainRecord(answer)
    ? { ...answer, [EnvelopeKey.REPEAT_HINT]: hint }
    : answer;
}

/** The error payload with the hint its call earned, if any. */
export function withRepeatHint<T extends object>(payload: T, error: unknown): T {
  const hint = 'object' === typeof error && null !== error ? hintByError.get(error) : undefined;
  return hint === undefined ? payload : { ...payload, [EnvelopeKey.REPEAT_HINT]: hint };
}
