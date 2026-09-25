/**
 * Learn a flow step's source file from the element its anchor resolved to on a replay.
 *
 * A step recorded before the build stamped the app names no file, so a scoped re-verify cannot say
 * which edits it covers. Every replay already asks the page for each anchor's element, and that
 * element carries its stamp now: this records the answer at the one place every resolution passes
 * through (the session's QUERY), rather than threading it through each step runner.
 */
import { ReticleCommand, asRecord, asString, type FlowFile, type FlowStep } from '@reticlehq/core';
import type { FlowReplaySession } from './flow-replay-types.js';
import { anchorQueryArgs } from './flow-step-runners.js';

type StepSource = NonNullable<FlowStep['source']>;

/** `src/Pay.tsx:12:4` or `src/Pay.tsx:12` → `{file, line}`; anything else is not a location. */
export function parseCompactSource(value: string): StepSource | undefined {
  const match = /^(.+?):(\d+)(?::\d+)?$/.exec(value);
  const file = match?.[1];
  const line = match?.[2];
  if (file === undefined || line === undefined) return undefined;
  return { file, line: Number(line) };
}

function keyOf(args: Record<string, unknown> | undefined): string | undefined {
  if (args === undefined) return undefined;
  const by = asString(args['by']);
  const value = asString(args['value']);
  if (by === undefined || value === undefined) return undefined;
  return JSON.stringify([by, value, asString(args['name']) ?? null]);
}

/** The one element a query found, when exactly one was found and it carries a stamp. */
function soleSource(result: unknown): StepSource | undefined {
  const elements = asRecord(result)?.['elements'];
  if (!Array.isArray(elements) || elements.length !== 1) return undefined;
  const source = asString(asRecord(elements[0])?.['source']);
  return source === undefined ? undefined : parseCompactSource(source);
}

/** Wrap a replay session so every anchor QUERY that resolves to one stamped element is remembered. */
export function recordingSources(inner: FlowReplaySession): {
  session: FlowReplaySession;
  sources: ReadonlyMap<string, StepSource>;
} {
  const sources = new Map<string, StepSource>();
  const session = new Proxy(inner, {
    // Bound to the target, never the proxy: a real Session keeps `#private` state, and a method
    // called with the proxy as `this` throws reading it.
    get(target, prop): unknown {
      if (prop !== 'command') {
        const value: unknown = Reflect.get(target, prop, target);
        return 'function' === typeof value ? (value as () => unknown).bind(target) : value;
      }
      return async (name: string, args?: Record<string, unknown>) => {
        const result = await target.command(name, args);
        const key = name === ReticleCommand.QUERY ? keyOf(args) : undefined;
        const source = result.ok ? soleSource(result.result) : undefined;
        if (key !== undefined && source !== undefined) sources.set(key, source);
        return result;
      };
    },
  });
  return { session, sources };
}

function learnSteps(
  steps: readonly FlowStep[],
  sources: ReadonlyMap<string, StepSource>,
): { steps: FlowStep[]; changed: boolean } {
  let changed = false;
  const next = steps.map((step) => {
    const nested = step.steps === undefined ? undefined : learnSteps(step.steps, sources);
    const learned =
      step.source === undefined
        ? sources.get(keyOf(anchorQueryArgs(step.anchor) ?? undefined) ?? '')
        : undefined;
    if (learned === undefined && nested?.changed !== true) return step;
    changed = true;
    return {
      ...step,
      ...(learned === undefined ? {} : { source: learned }),
      ...(nested === undefined ? {} : { steps: nested.steps }),
    };
  });
  return { steps: next, changed };
}

/** The flow with every sourceless step given the file its anchor resolved to; undefined if none was. */
export function withLearnedSources(
  flow: FlowFile,
  sources: ReadonlyMap<string, StepSource>,
): FlowFile | undefined {
  if (0 === sources.size) return undefined;
  const { steps, changed } = learnSteps(flow.steps, sources);
  return changed ? { ...flow, steps } : undefined;
}
