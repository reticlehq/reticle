import {
  AnchorKind,
  FLOW_FILE_VERSION,
  FlowErrorCode,
  FlowFileSchema,
  QueryBy,
} from '@iris/protocol';
import type { ActionType, FlowAnchor, FlowFile, FlowStep } from '@iris/protocol';
import { IrisTool } from './tool-names.js';
import type { CompiledProgram, RecordedStep } from './recordings.js';
import type { FileSystemPort } from './fs-port.js';
import { flowPath, irisDirPaths, isValidFlowName } from './iris-dir.js';

/** A monotonic clock injected for createdAt — never call Date.now() inside the store (rule 7). */
export interface Clock {
  now(): number;
}

/** Discriminated result so callers never branch on free strings. */
export type FlowResult<T> = { ok: true; value: T } | { ok: false; code: FlowErrorCode };

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Convert one normalized sub-step (act_sequence child) into an anchored FlowStep. */
function subStepToFlowStep(raw: unknown): FlowStep {
  const sub = asRecord(raw);
  const by = asString(sub['by']);
  const value = asString(sub['value']);
  const action = asString(sub['action']) as ActionType | undefined;
  const args = asRecord(sub['args']);
  if (by === QueryBy.TESTID && value !== undefined) {
    return buildStep(IrisTool.ACT, { kind: AnchorKind.TESTID, value }, action, args, false);
  }
  const ref = asString(sub['ref']) ?? '';
  return buildStep(IrisTool.ACT, { kind: AnchorKind.TESTID, value: ref }, action, args, true);
}

function buildStep(
  tool: string,
  anchor: FlowAnchor,
  action: ActionType | undefined,
  args: Record<string, unknown>,
  degraded: boolean,
): FlowStep {
  const step: FlowStep = { tool, anchor, args };
  if (action !== undefined) step.action = action;
  if (degraded) step.degraded = true;
  return step;
}

/**
 * Pure: map one normalized RecordedStep → FlowStep with a semantic anchor (+ degraded marker).
 * A ref-only (stable:false) step is recorded with a best-effort anchor and degraded:true —
 * NEVER silently dropped (FLOWFMT invariant). ACT_SEQUENCE recurses over its sub-steps.
 */
export function recordedStepToFlowStep(step: RecordedStep): FlowStep {
  if (step.tool === IrisTool.ACT_SEQUENCE) {
    const rawSubs = Array.isArray(step.args['steps']) ? step.args['steps'] : [];
    const subs = rawSubs.map(subStepToFlowStep);
    const degraded = subs.some((s) => s.degraded === true);
    const anchor: FlowAnchor = subs[0]?.anchor ?? { kind: AnchorKind.TESTID, value: '' };
    const out: FlowStep = { tool: IrisTool.ACT_SEQUENCE, anchor, steps: subs };
    if (degraded) out.degraded = true;
    if (step.expect !== undefined) out.expect = step.expect;
    return out;
  }

  const by = asString(step.args['by']);
  const value = asString(step.args['value']);
  const action = asString(step.args['action']) as ActionType | undefined;
  const args = asRecord(step.args['args']);
  const out =
    by === QueryBy.TESTID && value !== undefined
      ? buildStep(step.tool, { kind: AnchorKind.TESTID, value }, action, args, false)
      : buildStep(
          step.tool,
          { kind: AnchorKind.TESTID, value: asString(step.args['ref']) ?? '' },
          action,
          args,
          true,
        );
  if (step.expect !== undefined) out.expect = step.expect;
  return out;
}

interface SaveSummary {
  name: string;
  stepCount: number;
  degraded: number;
  empty: boolean;
}

const JSON_INDENT = 2;
const FLOW_SUFFIX = '.json';

/** Persists anchored flows to .iris/flows/<name>.json. Filesystem + clock are injected. */
export class FlowStore {
  readonly #fs: FileSystemPort;
  readonly #root: string;
  readonly #clock: Clock;

  constructor(fs: FileSystemPort, root: string, clock: Clock) {
    this.#fs = fs;
    this.#root = root;
    this.#clock = clock;
  }

  /** Convert a CompiledProgram (G6 testid-normalized) into an anchored, on-disk flow + write it. */
  async save(program: CompiledProgram): Promise<FlowResult<SaveSummary>> {
    if (!isValidFlowName(program.name)) {
      return { ok: false, code: FlowErrorCode.INVALID_NAME };
    }
    const steps = program.steps.map(recordedStepToFlowStep);
    const flow: FlowFile = {
      version: FLOW_FILE_VERSION,
      name: program.name,
      createdAt: this.#clock.now(),
      steps,
    };
    await this.#fs.mkdir(irisDirPaths(this.#root).flows);
    await this.#fs.writeFile(
      flowPath(this.#root, program.name),
      `${JSON.stringify(flow, null, JSON_INDENT)}\n`,
    );
    const degraded = steps.filter((s) => s.degraded === true).length;
    return {
      ok: true,
      value: { name: program.name, stepCount: steps.length, degraded, empty: steps.length === 0 },
    };
  }

  /** List flow names present under .iris/flows (no extension), sorted. [] if absent (no throw). */
  async list(): Promise<string[]> {
    const dir = irisDirPaths(this.#root).flows;
    if (!(await this.#fs.exists(dir))) return [];
    const entries = await this.#fs.readdir(dir);
    return entries
      .filter((e) => e.endsWith(FLOW_SUFFIX))
      .map((e) => e.slice(0, -FLOW_SUFFIX.length))
      .sort();
  }

  /** Read + zod-validate a flow by name. Structured codes; never throws on a missing/bad file. */
  async load(name: string): Promise<FlowResult<FlowFile>> {
    if (!isValidFlowName(name)) return { ok: false, code: FlowErrorCode.INVALID_NAME };
    const path = flowPath(this.#root, name);
    if (!(await this.#fs.exists(path))) return { ok: false, code: FlowErrorCode.NOT_FOUND };

    let text: string;
    try {
      text = await this.#fs.readFile(path);
    } catch (error) {
      return {
        ok: false,
        code: this.#fs.isNotFound(error) ? FlowErrorCode.NOT_FOUND : FlowErrorCode.PARSE_FAILED,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, code: FlowErrorCode.PARSE_FAILED };
    }
    const result = FlowFileSchema.safeParse(parsed);
    if (!result.success) return { ok: false, code: FlowErrorCode.PARSE_FAILED };
    return { ok: true, value: result.data };
  }
}
