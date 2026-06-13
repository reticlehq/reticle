import { IrisCommand, QueryBy } from '@syrin/iris-protocol';
import { IrisTool } from '../tools/tool-names.js';
import type { RecordedStep, CompiledProgram } from './recordings.js';
import type { Session } from '../session/session.js';

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Compile a single iris_act invocation into a normalized RecordedStep using the action result's testid. */
export function compileActStep(args: Record<string, unknown>, res: unknown): RecordedStep {
  const testid = asString(asRecord(res)['testid']);
  const action = asString(args['action']) ?? '';
  const actArgs = asRecord(args['args']);
  if (testid !== undefined) {
    return {
      tool: IrisTool.ACT,
      stable: true,
      args: { by: QueryBy.TESTID, value: testid, action, args: actArgs },
    };
  }
  return {
    tool: IrisTool.ACT,
    stable: false,
    args: { ref: asString(args['ref']) ?? '', action, args: actArgs },
  };
}

interface CompiledSubStep {
  by?: string;
  value?: string;
  ref?: string;
  action: string;
  args: Record<string, unknown>;
}

/** Compile an iris_act_sequence invocation, normalizing each sub-step to its testid where resolvable. */
export function compileSequenceStep(args: Record<string, unknown>, res: unknown): RecordedStep {
  const inputSteps = Array.isArray(args['steps']) ? args['steps'] : [];
  const resolved = Array.isArray(asRecord(res)['steps'])
    ? (asRecord(res)['steps'] as unknown[])
    : [];
  let stable = inputSteps.length > 0;
  const subSteps: CompiledSubStep[] = inputSteps.map((raw, i) => {
    const step = asRecord(raw);
    const action = asString(step['action']) ?? '';
    const stepArgs = asRecord(step['args']);
    const testid = asString(asRecord(resolved[i])['testid']);
    if (testid !== undefined) {
      return { by: QueryBy.TESTID, value: testid, action, args: stepArgs };
    }
    stable = false;
    return { ref: asString(step['ref']) ?? '', action, args: stepArgs };
  });
  return { tool: IrisTool.ACT_SEQUENCE, stable, args: { steps: subSteps } };
}

/** Resolve a recorded sub-step's element to a live ref via testid query, else fall back to its stored ref. */
async function resolveRef(
  session: Session,
  step: { by?: unknown; value?: unknown; ref?: unknown },
): Promise<{ ref: string; note?: string }> {
  const by = asString(step.by);
  const value = asString(step.value);
  if (by === QueryBy.TESTID && value !== undefined) {
    const result = await session.command(IrisCommand.QUERY, { by, value });
    if (!result.ok) throw new Error(result.error ?? 'query failed');
    const elements = Array.isArray(asRecord(result.result)['elements'])
      ? (asRecord(result.result)['elements'] as unknown[])
      : [];
    const ref = asString(asRecord(elements[0])['ref']);
    if (ref === undefined) throw new Error(`testid '${value}' did not resolve in current page`);
    return elements.length > 1
      ? { ref, note: `ambiguous testid '${value}', used first match` }
      : { ref };
  }
  const ref = asString(step.ref);
  if (ref === undefined || ref.length === 0)
    throw new Error('step has no testid or ref to resolve');
  return { ref, note: 'replayed by stale ref (not portable across sessions)' };
}

export interface ReplayStepResult {
  tool: string;
  ok: boolean;
  error?: string;
  note?: string;
}

/** Re-execute every step of a compiled program in order, stopping at the first failure. */
export async function replayProgram(
  session: Session,
  program: CompiledProgram,
): Promise<ReplayStepResult[]> {
  const results: ReplayStepResult[] = [];
  for (const step of program.steps) {
    try {
      if (step.tool === IrisTool.ACT_SEQUENCE) {
        const subs = Array.isArray(step.args['steps']) ? step.args['steps'] : [];
        const notes: string[] = [];
        const liveSteps: { ref: string; action: string; args: Record<string, unknown> }[] = [];
        for (const raw of subs) {
          const sub = asRecord(raw);
          const { ref, note } = await resolveRef(session, sub);
          if (note !== undefined) notes.push(note);
          liveSteps.push({
            ref,
            action: asString(sub['action']) ?? '',
            args: asRecord(sub['args']),
          });
        }
        const r = await session.command(IrisCommand.ACT_SEQUENCE, { steps: liveSteps });
        results.push(buildResult(step.tool, r.ok, r.error, notes));
        if (!r.ok) break;
      } else {
        const { ref, note } = await resolveRef(session, step.args);
        const r = await session.command(IrisCommand.ACT, {
          ref,
          action: asString(step.args['action']) ?? '',
          args: asRecord(step.args['args']),
        });
        results.push(buildResult(step.tool, r.ok, r.error, note !== undefined ? [note] : []));
        if (!r.ok) break;
      }
    } catch (e) {
      results.push({
        tool: step.tool,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
      break;
    }
  }
  return results;
}

function buildResult(
  tool: string,
  ok: boolean,
  error: string | undefined,
  notes: string[],
): ReplayStepResult {
  const base: ReplayStepResult = { tool, ok };
  if (!ok) base.error = error ?? 'command failed';
  if (notes.length > 0) base.note = notes.join('; ');
  return base;
}
