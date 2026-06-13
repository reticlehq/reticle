import {
  AnchorKind,
  DEGRADED_ANCHOR_ROLE,
  FLOW_FILE_VERSION,
  FlowErrorCode,
  FlowFileSchema,
  QueryBy,
} from '@iris/protocol';
import type { ActionType, FlowAnchor, FlowExpect, FlowFile, FlowStep } from '@iris/protocol';
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

/**
 * The anchor for a DEGRADED step (no resolvable testid). A volatile eXX ref is NEVER persisted —
 * the on-disk flow carries a placeholder ROLE anchor + degraded:true instead, so a ref can never
 * leak into a git-checked file and the step still round-trips (the ROLE anchor satisfies min(1)).
 */
function degradedAnchor(): FlowAnchor {
  return { kind: AnchorKind.ROLE, role: DEGRADED_ANCHOR_ROLE };
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
  return buildStep(IrisTool.ACT, degradedAnchor(), action, args, true);
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
    const anchor: FlowAnchor = subs[0]?.anchor ?? degradedAnchor();
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
      : buildStep(step.tool, degradedAnchor(), action, args, true);
  if (step.expect !== undefined) out.expect = step.expect;
  return out;
}

interface SaveSummary {
  name: string;
  stepCount: number;
  degraded: number;
  empty: boolean;
}

/**
 * M8 Stage B ANNOTATE — the structured annotations folded onto a flow at save time: per-step
 * expect predicates (assert-*), dynamic testids (mark-dynamic → flow.dynamic[]), and the flow's
 * success end-condition (success-state). All optional — a Stage-A save with no annotations writes
 * the same bytes as before.
 */
export interface FlowAnnotations {
  stepExpect: Map<number, FlowExpect>;
  dynamic: string[];
  success?: FlowExpect;
}

/** Apply folded annotations onto an anchored flow (pure): per-step expect, dynamic[], success. */
function withAnnotations(flow: FlowFile, ann: FlowAnnotations | undefined): FlowFile {
  if (ann === undefined) return flow;
  const steps = flow.steps.map((step, i) => {
    const expect = ann.stepExpect.get(i);
    return expect === undefined ? step : { ...step, expect };
  });
  const out: FlowFile = { ...flow, steps };
  if (ann.dynamic.length > 0) {
    out.dynamic = ann.dynamic.map((value) => ({ kind: AnchorKind.TESTID, value }));
  }
  if (ann.success !== undefined) out.success = ann.success;
  return out;
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

  /**
   * Convert a CompiledProgram (G6 testid-normalized) into an anchored, on-disk flow + write it.
   * M8 Stage B: optionally fold structured annotations (per-step expect, dynamic[], success) onto
   * the flow before writing. Omitting `annotations` reproduces the exact Stage-A bytes.
   */
  async save(
    program: CompiledProgram,
    annotations?: FlowAnnotations,
  ): Promise<FlowResult<SaveSummary>> {
    if (!isValidFlowName(program.name)) {
      return { ok: false, code: FlowErrorCode.INVALID_NAME };
    }
    const steps = program.steps.map(recordedStepToFlowStep);
    const base: FlowFile = {
      version: FLOW_FILE_VERSION,
      name: program.name,
      createdAt: this.#clock.now(),
      steps,
    };
    const flow = withAnnotations(base, annotations);
    await this.#fs.mkdir(irisDirPaths(this.#root).flows);
    await this.#fs.writeFile(
      flowPath(this.#root, program.name),
      `${JSON.stringify(flow, null, JSON_INDENT)}\n`,
    );
    const degraded = flow.steps.filter((s) => s.degraded === true).length;
    return {
      ok: true,
      value: {
        name: program.name,
        stepCount: flow.steps.length,
        degraded,
        empty: flow.steps.length === 0,
      },
    };
  }

  /**
   * M8 Stage B: persist an already-anchored FlowFile captured in-page (no recompilation). The
   * browser resolved every semantic anchor at capture time; here we only validate the name +
   * re-run FlowFileSchema before writing. save() is left untouched (no Stage A regression).
   */
  async saveFlow(flow: FlowFile): Promise<FlowResult<SaveSummary>> {
    if (!isValidFlowName(flow.name)) return { ok: false, code: FlowErrorCode.INVALID_NAME };
    const parsed = FlowFileSchema.safeParse(flow);
    if (!parsed.success) return { ok: false, code: FlowErrorCode.PARSE_FAILED };
    const valid = parsed.data;
    await this.#fs.mkdir(irisDirPaths(this.#root).flows);
    await this.#fs.writeFile(
      flowPath(this.#root, valid.name),
      `${JSON.stringify(valid, null, JSON_INDENT)}\n`,
    );
    const degraded = valid.steps.filter((s) => s.degraded === true).length;
    return {
      ok: true,
      value: {
        name: valid.name,
        stepCount: valid.steps.length,
        degraded,
        empty: valid.steps.length === 0,
      },
    };
  }

  /**
   * M8 Stage B self-healing: rewrite one step's testid anchor on disk (the iris_flow_heal apply
   * path). Only the targeted step's TESTID anchor value changes; every other step is byte-identical
   * (locked by a test). A non-testid or out-of-range step is a no-op rebind (returns the flow).
   */
  async rebindAnchor(
    name: string,
    stepIndex: number,
    newTestid: string,
  ): Promise<FlowResult<FlowFile>> {
    const loaded = await this.load(name);
    if (!loaded.ok) return loaded;
    const flow = loaded.value;
    const target = flow.steps[stepIndex];
    if (target === undefined || target.anchor.kind !== AnchorKind.TESTID) {
      return { ok: true, value: flow };
    }
    const next: FlowFile = {
      ...flow,
      steps: flow.steps.map((s, i) =>
        i === stepIndex ? { ...s, anchor: { kind: AnchorKind.TESTID, value: newTestid } } : s,
      ),
    };
    await this.#fs.writeFile(
      flowPath(this.#root, name),
      `${JSON.stringify(next, null, JSON_INDENT)}\n`,
    );
    return { ok: true, value: next };
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
