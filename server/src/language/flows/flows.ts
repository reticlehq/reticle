import {
  asFlowName,
  asProjectId,
  type FlowName,
  type Predicate,
  type ProjectId,
} from '@reticlehq/core';
import { REDACTED_FILL } from './fields/flow-secret-field.js';
export { REDACTED_FILL } from './fields/flow-secret-field.js';
import { safeProjectId, type FlowResult } from './flow-result.js';
import { changeInPlace } from './narrow-write.js';
export type { FlowResult } from './flow-result.js';
import {
  AnchorKind,
  DEGRADED_ANCHOR_ROLE,
  FLOW_FILE_VERSION,
  FlowErrorCode,
  FlowFileSchema,
  FlowStepTool,
  QueryBy,
  defaultIsSensitiveKey,
} from '@reticlehq/core';
import type {
  ActionType,
  FlowAnchor,
  FlowFile,
  FlowStep,
  HealChange,
  InstrumentationGap,
} from '@reticlehq/core';
import { ReticleTool } from '@reticlehq/core';
import { asRecord, asString } from '@reticlehq/core';
import { applyHealChanges } from './heal.js';
import { withLearnedSources } from './learned-sources.js';
import { flowIntentGap, linkFlowIntent } from './flow-intent.js';
import { IntentStore } from '@/memory/intent/intent-store.js';
import type { CompiledProgram, RecordedStep } from './recording/tape/recordings.js';
import type { FileSystemPort } from '@/memory/project/fs/fs-port.js';
import {
  flowDir,
  flowParentDir,
  flowPath,
  reticleDirPaths,
  isValidFlowName,
} from '@/memory/project/dir/reticle-dir.js';
import { describeFlowZodFailure, parseFlowFileText } from './flow-expect-grammar.js';
import type { Clock } from '@/machine/clock.js';

/**
 * The anchor for a DEGRADED step (no resolvable testid). A volatile eXX ref is NEVER persisted —
 * the on-disk flow carries a placeholder ROLE anchor + degraded:true instead, so a ref can never
 * leak into a git-checked file and the step still round-trips (the ROLE anchor satisfies min(1)).
 */
function degradedAnchor(): FlowAnchor {
  return { kind: AnchorKind.ROLE, role: DEGRADED_ANCHOR_ROLE };
}

/**
 * Build a stable `component` auto-anchor from a normalized step's component/source args. Returns
 * null when neither is present (caller falls back to degraded). The on-disk anchor carries the
 * component name + source location — re-resolvable by `reticle_query by:'component'` at replay.
 */
/** The `source` location carried on a normalized step's args, or undefined if absent/malformed. */
function sourceArg(
  src: Record<string, unknown>,
): { file: string; line: number; column?: number } | undefined {
  const source = asRecord(src['source']);
  const file = source['file'];
  const line = source['line'];
  if (typeof file !== 'string' || 0 === file.length || typeof line !== 'number') return undefined;
  const out: { file: string; line: number; column?: number } = { file, line };
  if ('number' === typeof source['column']) out.column = source['column'];
  return out;
}

function componentAnchor(src: Record<string, unknown>): FlowAnchor | null {
  const component = asString(src['component']);
  const source = sourceArg(src);
  if (component === undefined && source === undefined) return null;
  const anchor: Extract<FlowAnchor, { kind: typeof AnchorKind.COMPONENT }> = {
    kind: AnchorKind.COMPONENT,
  };
  if (component !== undefined) anchor.component = component;
  if (source !== undefined) anchor.source = source;
  return anchor;
}

/** Pick the on-disk anchor for a normalized step: testid > component(auto) > degraded role. */
export function anchorForStep(args: Record<string, unknown>): {
  anchor: FlowAnchor;
  degraded: boolean;
} {
  const by = asString(args['by']);
  const value = asString(args['value']);
  if (by === QueryBy.TESTID && value !== undefined) {
    const anchor: Extract<FlowAnchor, { kind: typeof AnchorKind.TESTID }> = {
      kind: AnchorKind.TESTID,
      value,
    };
    const source = sourceArg(args);
    if (source !== undefined) anchor.source = source;
    return { anchor, degraded: false };
  }
  // Role + NAME is a real anchor, not a degraded placeholder.
  //
  // The vocabulary has always described `{ kind:'role', role, name }` as an addressable anchor, and
  // nothing ever produced one — the only ROLE anchor written to disk was the degraded placeholder
  // that means "add a data-testid". So a step the recorder anchored by accessible name arrived here
  // and had that name thrown away, which is precisely the anchor that distinguishes one row's
  // control from another's when a shared JSX source location cannot.
  if (by === QueryBy.ROLE && value !== undefined) {
    const name = asString(args['name']);
    if (name !== undefined && name.length > 0) {
      // The schema carries role + name only; provenance lives on the step, not the anchor.
      return { anchor: { kind: AnchorKind.ROLE, role: value, name }, degraded: false };
    }
  }
  if (by === QueryBy.COMPONENT) {
    const anchor = componentAnchor(args);
    if (anchor !== null) return { anchor, degraded: false };
  }
  return { anchor: degradedAnchor(), degraded: true };
}

/** Convert one normalized sub-step (act_sequence child) into an anchored FlowStep. */
function subStepToFlowStep(raw: unknown): FlowStep {
  const sub = asRecord(raw);
  const action = asString(sub['action']) as ActionType | undefined;
  const args = asRecord(sub['args']);
  const { anchor, degraded } = anchorForStep(sub);
  const step = buildStep(ReticleTool.ACT, anchor, action, args, degraded);
  /*
   * The sub-step's own declared consequence, carried rather than folded into the parent.
   *
   * A sequence is one recorded step and one batched dispatch, but each of its steps claimed
   * something different. Hanging every claim off the parent would let one signal answer for every
   * click in the journey -- and `classifyFlowAssertions` already walks sub-steps looking for
   * exactly this, so dropping it here made the grader count assertions that were never saved.
   */
  const expect = sub['expect'] as NonNullable<FlowStep['expect']> | undefined;
  if (expect !== undefined) step.expect = expect;
  return step;
}

/**
 * Strip credentials from what gets written to disk.
 *
 * The flow store is git-checked, and recording a sign-in captures the fill VALUE verbatim — so
 * without this the first flow recorded on an authenticated app writes a password into a file the
 * user then commits.
 *
 * Keyed off the ANCHOR, not the value: the anchor names the field, so a credential is recognised by
 * WHERE it was typed rather than by guessing whether the characters look secret — a guess that both
 * over-redacts a search box and misses a password that happens to be a dictionary word.
 *
 * `defaultIsSensitiveKey` is the same rule the network channel redacts by, so a field considered
 * sensitive on the wire cannot be considered safe on disk.
 */
function redactSecretFill(
  anchor: FlowAnchor,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof args['value'] !== 'string') return args;
  const field = anchorFieldName(anchor);
  if (field === undefined || !defaultIsSensitiveKey(field)) return args;
  return { ...args, value: REDACTED_FILL };
}

/**
 * What the anchor CALLS the field it points at.
 *
 * Every anchor kind names its target differently and all of them can name a password: a testid
 * (auth-password), an accessible name (role=textbox, name="Password"), a signal. Checking only the
 * testid variant would redact the app that uses test ids and quietly leak the one that does not —
 * and an app without test ids is exactly the app whose flows were recorded by role.
 *
 * Exported because REPLAY has to agree with redaction about what the field is called. It did not:
 * the replay paths took a `field` argument that only the testid caller passed, so a role-anchored
 * secret was redacted at save under one name and looked up at replay under none — the flow typed
 * the placeholder into the form. One function decides it for both sides, or the two drift again.
 */
export function anchorFieldName(anchor: FlowAnchor): string | undefined {
  if (AnchorKind.TESTID === anchor.kind) return anchor.value;
  if (AnchorKind.ROLE === anchor.kind) return anchor.name;
  if (AnchorKind.SIGNAL === anchor.kind) return anchor.name;
  return undefined;
}

function buildStep(
  tool: string,
  anchor: FlowAnchor,
  action: ActionType | undefined,
  args: Record<string, unknown>,
  degraded: boolean,
): FlowStep {
  const step: FlowStep = { tool, anchor, args: redactSecretFill(anchor, args) };
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
  if (step.invoke !== undefined) {
    // An invocation drives nothing: no action, no args, and an anchor only because every step
    // carries one. Falling through to the action path below would give it an `action` and a
    // replayer would try to dispatch a step whose whole meaning is "go and run that document".
    const out: FlowStep = {
      tool: FlowStepTool.INVOKE,
      anchor: { kind: AnchorKind.TESTID, value: step.invoke },
      invoke: step.invoke,
    };
    if (step.expect !== undefined) out.expect = step.expect;
    return out;
  }
  if (step.tool === ReticleTool.ACT_SEQUENCE) {
    const rawSubs = Array.isArray(step.args['steps']) ? step.args['steps'] : [];
    const subs = rawSubs.map(subStepToFlowStep);
    const degraded = subs.some((s) => true === s.degraded);
    // The first sub-step that HAS an anchor, not blindly the first. Taking subs[0] handed the whole
    // sequence the degraded sentinel whenever sub-step 0 lacked a testid — even with every later
    // sub-step perfectly anchored — and replay then queried the DOM for a testid literally named
    // "unresolved", so the step drifted on all 5 apps, every replay.
    const anchor: FlowAnchor =
      subs.find((s) => s.degraded !== true)?.anchor ?? subs[0]?.anchor ?? degradedAnchor();
    const out: FlowStep = { tool: ReticleTool.ACT_SEQUENCE, anchor, steps: subs };
    if (degraded) out.degraded = true;
    if (step.expect !== undefined) out.expect = step.expect;
    return out;
  }

  const action = asString(step.args['action']) as ActionType | undefined;
  const args = asRecord(step.args['args']);
  const { anchor, degraded } = anchorForStep(step.args);
  const out = buildStep(step.tool, anchor, action, args, degraded);
  if (step.expect !== undefined) out.expect = step.expect;
  return out;
}

interface SaveSummary {
  name: string;
  stepCount: number;
  degraded: number;
  empty: boolean;
  /**
   * Present only when the flow was saved with nothing saying what it is for. Never blocks the save,
   * and absent the moment the flow carries prose or an `intentId`. See `flowIntentGap`.
   */
  intentGap?: InstrumentationGap;
}

/**
 * The structured annotations folded onto a flow at save time: per-step
 * expect predicates (assert-*), dynamic testids (mark-dynamic → flow.dynamic[]), and the flow's
 * success end-condition (success-state). All optional — a save with no annotations writes
 * the same bytes as before.
 */
export interface FlowAnnotations {
  stepExpect: Map<number, Predicate>;
  dynamic: string[];
  success?: Predicate;
  /** The flow's declared business goal (intent annotation). */
  intent?: string;
}

/** Apply folded annotations onto an anchored flow (pure): per-step expect, dynamic[], success, intent. */
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
  if (ann.intent !== undefined) out.intent = ann.intent;
  return out;
}

const JSON_INDENT = 2;
const FLOW_SUFFIX = '.json';

/** Persists anchored flows to .reticle/flows/<name>.json. Filesystem + clock are injected. */
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
   * The single byte-stable flow serializer: 2-space indent + one trailing newline. save,
   * saveFlow and heal all route through it so an unchanged flow that round-trips through any
   * of them produces byte-identical on-disk content (locked by the byte-stability tests).
   */
  #serialize(flow: FlowFile): string {
    return `${JSON.stringify(flow, null, JSON_INDENT)}\n`;
  }

  /**
   * Register the flow's business goal in the intent ledger and stamp the row's id onto the flow.
   *
   * Both save paths route through here — the compiled-recording one and the in-page recorder one —
   * because a flow's goal must land in the ledger whichever way the flow arrived. A flow with no
   * goal is returned untouched and nothing is written, so an older flow keeps its exact bytes.
   */
  #linkIntent(flow: FlowFile): Promise<FlowFile> {
    return linkFlowIntent(new IntentStore(this.#fs, this.#root, this.#clock), flow);
  }

  /**
   * What a caller is told about a flow that just landed on disk.
   *
   * Both save paths build it here rather than each assembling their own object, because the two used
   * to be duplicates and the intent nudge is exactly the kind of field that gets added to one of a
   * pair. A flow saved by the recorder and a flow saved from a compiled recording are the same
   * regression test, and must not report differently for having arrived by a different door.
   */
  #summary(flow: FlowFile): SaveSummary {
    const gap = flowIntentGap(flow);
    return {
      name: flow.name,
      stepCount: flow.steps.length,
      degraded: flow.steps.filter((s) => true === s.degraded).length,
      empty: 0 === flow.steps.length,
      ...(gap === undefined ? {} : { intentGap: gap }),
    };
  }

  /**
   * Convert a CompiledProgram (testid-normalized) into an anchored, on-disk flow + write it.
   * Optionally fold structured annotations (per-step expect, dynamic[], success) onto
   * the flow before writing. Omitting `annotations` reproduces the same bytes.
   */
  async save(
    program: CompiledProgram,
    annotations?: FlowAnnotations,
    projectId?: ProjectId,
  ): Promise<FlowResult<SaveSummary>> {
    if (!isValidFlowName(program.name)) {
      return { ok: false, code: FlowErrorCode.INVALID_NAME };
    }
    const pid = safeProjectId(projectId);
    const steps = program.steps.map(recordedStepToFlowStep);
    const base: FlowFile = {
      version: FLOW_FILE_VERSION,
      name: program.name,
      ...(pid === undefined ? {} : { projectId: pid }),
      createdAt: this.#clock.now(),
      steps,
      /*
       * The route the journey started on, when the recording captured one.
       *
       * The in-page recorder has always written this; the agent's recording had nowhere to put it,
       * so a flow an agent recorded replayed from wherever the tab happened to be. A first step
       * whose whole consequence is "this navigation fetches" fetches nothing when replay already
       * sits on the destination, and the flow then drifts for a reason that has nothing to do with
       * the app. Observed doing exactly that.
       */
      ...(program.startPath === undefined ? {} : { startPath: program.startPath }),
    };
    const flow = await this.#linkIntent(withAnnotations(base, annotations));
    await this.#fs.mkdir(flowParentDir(this.#root, program.name, pid));
    await this.#fs.writeFile(flowPath(this.#root, program.name, pid), this.#serialize(flow));
    return { ok: true, value: this.#summary(flow) };
  }

  /**
   * Persist an already-anchored FlowFile captured in-page (no recompilation). The
   * browser resolved every semantic anchor at capture time; here we only validate the name +
   * re-run FlowFileSchema before writing. save is left untouched.
   */
  async saveFlow(flow: FlowFile, projectId?: ProjectId): Promise<FlowResult<SaveSummary>> {
    if (!isValidFlowName(flow.name)) return { ok: false, code: FlowErrorCode.INVALID_NAME };
    const pid = safeProjectId(projectId);
    // Stamp the project INTO the file (so a flow carries its own scope) and route it to the matching
    // per-project subdir. Both come from the same `pid`, so on-disk location and content always agree.
    const stamped = pid === undefined ? flow : { ...flow, projectId: pid };
    const parsed = FlowFileSchema.safeParse(stamped);
    if (!parsed.success) {
      // Named, not bare: the load path already says which step and key it choked on, and a save
      // that refuses in silence sends the caller to the file to guess at what a load would tell it.
      return {
        ok: false,
        code: FlowErrorCode.PARSE_FAILED,
        detail: describeFlowZodFailure(parsed.error),
      };
    }
    const valid = await this.#linkIntent(parsed.data);
    await this.#fs.mkdir(flowParentDir(this.#root, asFlowName(valid.name), pid));
    await this.#fs.writeFile(
      flowPath(this.#root, asFlowName(valid.name), pid),
      this.#serialize(valid),
    );
    return { ok: true, value: this.#summary(valid) };
  }

  /**
   * Load a flow, change one thing, write the SAME file load resolved.
   *
   * Guards the name before a path is joined (traversal), writes where load found it (never forks a
   * copy), and VALIDATES first — `load` validates, and a writer that does not authors files its own
   * reader rejects, which cost a flow permanently. Not `saveFlow`: that re-runs `#linkIntent` over
   * the whole document and reverts an intent a replay just discharged.
   */
  async #changeInPlace<T>(
    name: string,
    projectId: ProjectId | undefined,
    change: (flow: FlowFile) => { next: FlowFile; value: T },
  ): Promise<FlowResult<T>> {
    return await changeInPlace(
      {
        load: (n, p) => this.load(n, p),
        // Branded at the boundary: the port speaks strings, the store speaks FlowName, and the
        // name has already passed isValidFlowName inside changeInPlace.
        resolvePath: (n, p) => this.#resolveReadPath(asFlowName(n), p),
        write: (path, contents) => this.#fs.writeFile(path, contents),
        serialize: (flow) => this.#serialize(flow),
      },
      name,
      projectId,
      change,
    );
  }

  /** Write back only what a replay LEARNED. See `#changeInPlace` for why it is not `saveFlow`. */
  async recordLearned(
    name: string,
    learned: NonNullable<FlowFile['learned']>,
    projectId?: ProjectId,
  ): Promise<FlowResult<{ name: string }>> {
    return await this.#changeInPlace(name, projectId, (flow) => ({
      next: { ...flow, learned },
      value: { name },
    }));
  }

  /** Give sourceless steps the files a clean replay resolved them to, merged onto the file as it is now. */
  async recordSources(
    name: string,
    sources: ReadonlyMap<string, NonNullable<FlowStep['source']>>,
    projectId?: ProjectId,
  ): Promise<FlowResult<{ name: string }>> {
    return await this.#changeInPlace(name, projectId, (flow) => ({
      next: withLearnedSources(flow, sources) ?? flow,
      value: { name },
    }));
  }

  /**
   * Apply confident testid rebinds to an on-disk flow (the `reticle_flow_heal` apply path),
   * rewriting ONLY the named steps' anchors and preserving every other field. Loading, the name
   * guard, validation and byte-stable serialisation are `#changeInPlace`'s.
   *
   * PURE of the confidence policy: it trusts the changes handed to it, because the tool only calls
   * it with proposals that already cleared HEAL_CONFIDENCE_MIN. A change whose `from` no longer
   * matches the step's anchor is skipped — idempotent and defensive, never throwing.
   */
  async heal(
    name: string,
    changes: HealChange[],
    projectId?: ProjectId,
  ): Promise<FlowResult<{ name: string; changed: HealChange[] }>> {
    return await this.#changeInPlace(name, projectId, (flow) => {
      // The store's injected clock, so a written flow records when the rebind actually happened.
      const { flow: next, applied } = applyHealChanges(flow, changes, () => this.#clock.now());
      return { next, value: { name, changed: applied } };
    });
  }

  /** The `.json` basenames (no extension) directly inside `dir`. [] if the dir is absent/unreadable. */
  async #namesIn(dir: string): Promise<string[]> {
    if (!(await this.#fs.exists(dir))) return [];
    let entries: string[];
    try {
      entries = await this.#fs.readdir(dir);
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.endsWith(FLOW_SUFFIX))
      .map((e) => e.slice(0, -FLOW_SUFFIX.length));
  }

  /**
   * List flow names visible to a caller, sorted + deduped. With a `projectId`: that project's own
   * flows PLUS legacy flat (untagged/global) ones. Without one (CLI/CI/contract callers): EVERY flow
   * in the store — flat plus every per-project subdir — so a repo-wide replay/audit misses nothing.
   */
  /**
   * All flow names on disk, INCLUDING any that fail the path-segment guard — an invalid name must reach
   * the caller as a reportable error, never be silently filtered away. Callers that build a path from a
   * name must validate first; `flowPath` takes a branded FlowName precisely so the compiler insists.
   */
  async list(projectId?: ProjectId): Promise<string[]> {
    const flowsDir = reticleDirPaths(this.#root).flows;
    const pid = safeProjectId(projectId);
    const legacy = await this.#namesIn(flowsDir);
    if (pid !== undefined) {
      const own = await this.#namesIn(flowDir(this.#root, pid));
      return [...new Set([...own, ...legacy])].sort();
    }
    if (!(await this.#fs.exists(flowsDir))) return [];
    let entries: string[];
    try {
      entries = await this.#fs.readdir(flowsDir);
    } catch {
      return legacy.sort();
    }
    // Every subdirectory of `.reticle/flows/` is a project's, by construction: this class is the
    // only thing that creates one, and it creates it from a projectId that already passed
    // `safeProjectId`. Reading the name back is the third provenance boundary, not a cast.
    const subdirs = entries.filter((e) => !e.endsWith(FLOW_SUFFIX));
    const nested = (
      await Promise.all(subdirs.map((d) => this.#namesIn(flowDir(this.#root, asProjectId(d)))))
    ).flat();
    return [...new Set([...legacy, ...nested])].sort();
  }

  /** The path a flow actually lives at: nested (per-project) if present, else legacy flat, else null. */
  async #resolveReadPath(name: FlowName, pid: ProjectId | undefined): Promise<string | null> {
    if (pid !== undefined) {
      const nested = flowPath(this.#root, name, pid);
      if (await this.#fs.exists(nested)) return nested;
    }
    const flat = flowPath(this.#root, name);
    if (await this.#fs.exists(flat)) return flat;
    // No projectId (CLI/CI/contract callers, e.g. reticle_domain): mirror list's subdir union on
    // the read side too — a flow saved under .reticle/flows/<projectId>/ must still load, else it is
    // listed and then silently dropped by `if (loaded.ok)` (reticle_domain reports flowCount:0).
    if (pid === undefined) return this.#resolveNestedPath(name);
    return null;
  }

  /** Scan the per-project subdirs for a flow by name — the read-side of list's no-pid union. */
  async #resolveNestedPath(name: FlowName): Promise<string | null> {
    const flowsDir = reticleDirPaths(this.#root).flows;
    if (!(await this.#fs.exists(flowsDir))) return null;
    let entries: string[];
    try {
      entries = await this.#fs.readdir(flowsDir);
    } catch {
      return null;
    }
    // Same provenance as `#namesIn`'s scan above: a subdir of `.reticle/flows/` is a projectId.
    for (const dir of entries.filter((e) => !e.endsWith(FLOW_SUFFIX))) {
      const nested = flowPath(this.#root, name, asProjectId(dir));
      if (await this.#fs.exists(nested)) return nested;
    }
    return null;
  }

  /**
   * Read + zod-validate a flow by name. With a `projectId`, prefers the per-project copy and falls
   * back to a legacy flat (untagged) flow of the same name — so pre-existing flows keep loading.
   */
  async load(name: string, projectId?: ProjectId): Promise<FlowResult<FlowFile>> {
    if (!isValidFlowName(name)) return { ok: false, code: FlowErrorCode.INVALID_NAME };
    const path = await this.#resolveReadPath(name, safeProjectId(projectId));
    if (null === path) return { ok: false, code: FlowErrorCode.NOT_FOUND };

    let text: string;
    try {
      text = await this.#fs.readFile(path);
    } catch (error) {
      return {
        ok: false,
        code: this.#fs.isNotFound(error) ? FlowErrorCode.NOT_FOUND : FlowErrorCode.PARSE_FAILED,
      };
    }

    return parseFlowFileText(text);
  }

  /**
   * Delete a flow's file so a renamed/obsolete flow stops lingering in the replay list. Resolves the
   * same path `load` would (per-project copy, else legacy flat, else a subdir scan for the no-pid
   * caller), then removes it. NOT_FOUND when nothing resolves — deleting an absent flow is an error,
   * not a silent no-op, so a typo doesn't read as success.
   */
  async remove(name: string, projectId?: ProjectId): Promise<FlowResult<void>> {
    if (!isValidFlowName(name)) return { ok: false, code: FlowErrorCode.INVALID_NAME };
    const path = await this.#resolveReadPath(name, safeProjectId(projectId));
    if (null === path) return { ok: false, code: FlowErrorCode.NOT_FOUND };
    await this.#fs.rm(path);
    return { ok: true, value: undefined };
  }
}
