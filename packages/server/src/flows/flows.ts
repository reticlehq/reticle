import {
  AnchorKind,
  DEGRADED_ANCHOR_ROLE,
  FLOW_FILE_VERSION,
  FlowErrorCode,
  FlowFileSchema,
  QueryBy,
} from '@syrin/iris-protocol';
import type {
  ActionType,
  FlowAnchor,
  FlowExpect,
  FlowFile,
  FlowStep,
  HealChange,
} from '@syrin/iris-protocol';
import { IrisTool } from '../tools/tool-names.js';
import type { CompiledProgram, RecordedStep } from './recordings.js';
import type { FileSystemPort } from '../project/fs-port.js';
import { flowPath, irisDirPaths, isValidFlowName } from '../project/iris-dir.js';

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
 * NEVER silently dropped. ACT_SEQUENCE recurses over its sub-steps.
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
 * The structured annotations folded onto a flow at save time: per-step
 * expect predicates (assert-*), dynamic testids (mark-dynamic → flow.dynamic[]), and the flow's
 * success end-condition (success-state). All optional — a save with no annotations writes
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
   * The single byte-stable flow serializer: 2-space indent + one trailing newline. save(),
   * saveFlow() and heal() all route through it so an unchanged flow that round-trips through any
   * of them produces byte-identical on-disk content (locked by the byte-stability tests).
   */
  #serialize(flow: FlowFile): string {
    return `${JSON.stringify(flow, null, JSON_INDENT)}\n`;
  }

  /**
   * Convert a CompiledProgram (testid-normalized) into an anchored, on-disk flow + write it.
   * Optionally fold structured annotations (per-step expect, dynamic[], success) onto
   * the flow before writing. Omitting `annotations` reproduces the same bytes.
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
    await this.#fs.writeFile(flowPath(this.#root, program.name), this.#serialize(flow));
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
   * Persist an already-anchored FlowFile captured in-page (no recompilation). The
   * browser resolved every semantic anchor at capture time; here we only validate the name +
   * re-run FlowFileSchema before writing. save() is left untouched.
   */
  async saveFlow(flow: FlowFile): Promise<FlowResult<SaveSummary>> {
    if (!isValidFlowName(flow.name)) return { ok: false, code: FlowErrorCode.INVALID_NAME };
    const parsed = FlowFileSchema.safeParse(flow);
    if (!parsed.success) return { ok: false, code: FlowErrorCode.PARSE_FAILED };
    const valid = parsed.data;
    await this.#fs.mkdir(irisDirPaths(this.#root).flows);
    await this.#fs.writeFile(flowPath(this.#root, valid.name), this.#serialize(valid));
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
   * Apply confident testid rebinds to an on-disk flow (the iris_flow_heal
   * apply path). Loads + validates the flow (so it gets NOT_FOUND / PARSE_FAILED for free), then
   * rewrites ONLY the named steps' testid anchors — preserving createdAt + every other field — and
   * re-serializes byte-stably via the same #serialize() that save() uses. The name guard runs
   * FIRST, before any path is joined, so a traversal name never reaches the disk.
   *
   * This writer is PURE of the confidence policy: it trusts the changes it is handed (the tool only
   * calls it with proposals that already cleared HEAL_CONFIDENCE_MIN). A change whose `from` no
   * longer matches the step's testid anchor is skipped (idempotent / defensive), never throwing.
   */
  async heal(
    name: string,
    changes: HealChange[],
  ): Promise<FlowResult<{ name: string; changed: HealChange[] }>> {
    if (!isValidFlowName(name)) return { ok: false, code: FlowErrorCode.INVALID_NAME };
    const loaded = await this.load(name);
    if (!loaded.ok) return { ok: false, code: loaded.code };
    const flow = loaded.value;

    const byStep = new Map<number, HealChange>();
    for (const change of changes) byStep.set(change.step, change);

    const applied: HealChange[] = [];
    const steps = flow.steps.map((step, index): FlowStep => {
      const change = byStep.get(index);
      if (
        change === undefined ||
        step.anchor.kind !== AnchorKind.TESTID ||
        step.anchor.value !== change.from
      ) {
        return step;
      }
      applied.push(change);
      return { ...step, anchor: { kind: AnchorKind.TESTID, value: change.to } };
    });

    const next: FlowFile = { ...flow, steps };
    await this.#fs.writeFile(flowPath(this.#root, name), this.#serialize(next));
    return { ok: true, value: { name, changed: applied } };
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
