import {
  SECRET_FIELD_ARG,
  SECRET_NAME_ARG,
  secretKeyForFill,
  secretValue,
} from './fields/flow-secret-field.js';
import {
  EventType,
  FlowPredicateSchema,
  MUTATING_METHODS,
  isDevToolingUrl,
  type Predicate,
  type ReticleEvent,
} from '@reticlehq/core';
import {
  DANGEROUS_ACTION_CONFIRM_ARG,
  DOCUMENT_ANCHOR_ROLE,
  ReticleCommand,
  QueryBy,
  isGlobalPressCall,
  type CommandResult,
} from '@reticlehq/core';
import { ReticleTool, invokedFlowMissing } from '@reticlehq/core';
import { formatStepAddress } from 'open-verification';
import { refFor } from './flow-anchor.js';
import { navigablePath, routeOfUrl } from '@reticlehq/engine/question/predicate/predicate-route.js';
import type { RecordedStep, CompiledProgram } from './recording/tape/recordings.js';
import type { Session } from '@/portal/session/session.js';
import { asRecord, asString } from '@reticlehq/core';

/**
 * The note attached when a testid resolves to multiple live elements (the first match is used).
 * Shared by BOTH replay engines (replayProgram + flow-replay's step runner) so the phrasing — which
 * an agent reads to judge a brittle locator — can never drift between them.
 */
export function ambiguousTestidNote(value: string): string {
  return `ambiguous testid '${value}', used first match`;
}

function ambiguousRoleNote(role: string, name: string): string {
  return `ambiguous ${role} named '${name}', used first match`;
}

/**
 * The live element refs a QUERY resolved to (empty when it failed or matched nothing). Shared by BOTH
 * replay engines (replayProgram + flow-replay's step runner) so element extraction — the core of anchor
 * resolution — can't drift between them.
 */
/**
 * The refs of a role query's matches that have NO accessible name, in page order.
 *
 * A role query without a name returns every control of the role, named ones included. A nameless
 * anchor's recorded position (`nth` of `of`) counts only the nameless ones — an icon-only edit
 * button is the 2nd nameless button of its row, not the 5th button — so the named ones are dropped
 * before the position is read.
 */
export function namelessRefs(result: CommandResult): string[] {
  if (!result.ok) {
    return [];
  }
  const elements = asRecord(result.result)['elements'];
  if (!Array.isArray(elements)) {
    return [];
  }
  const refs: string[] = [];
  for (const element of elements) {
    const e = asRecord(element);
    const ref = asString(e['ref']);
    if (0 === (asString(e['name']) ?? '').trim().length && ref !== undefined) {
      refs.push(ref);
    }
  }
  return refs;
}

export function queryRefs(result: CommandResult): string[] {
  if (!result.ok) {
    return [];
  }
  const payload = asRecord(result.result);
  const elements = Array.isArray(payload['elements']) ? payload['elements'] : [];
  return elements.map((e) => asString(asRecord(e)['ref']) ?? '').filter((r) => r.length > 0);
}

/**
 * A destructive-action confirmation is one-shot and must never persist into a recording.
 *
 * This is also where a REDACTED fill is supplied back. Stripping credentials out of a git-checked
 * flow is only half a fix: sign-in still has to replay, and a flow that drifts at step two forever
 * because its own password was removed is a flow nobody keeps — along with everything behind the
 * login it guards. The value comes from the environment, the one place a secret can live that is
 * neither the customer's repository nor our database.
 *
 * Left as the PLACEHOLDER when nothing supplies it, rather than blanked. The replay then fails at
 * the login form with `<redacted: supply at replay>` visible in the field, which names its own fix;
 * an empty box fails identically and tells the reader nothing.
 */
export function replayActionArgs(
  value: unknown,
  confirmDangerous = false,
  field?: string,
): Record<string, unknown> {
  const args = { ...asRecord(value) };
  delete args[DANGEROUS_ACTION_CONFIRM_ARG];
  const key = field === undefined ? undefined : secretKeyForFill(args, field);
  delete args[SECRET_NAME_ARG];
  delete args[SECRET_FIELD_ARG];
  if (confirmDangerous) {
    args[DANGEROUS_ACTION_CONFIRM_ARG] = true;
  }
  if (key !== undefined) {
    const supplied = secretValue(key, process.env);
    if (supplied !== undefined && supplied.length > 0) {
      args['value'] = supplied;
    }
  }
  return args;
}

/**
 * The field a compiled recording step names — the same mapping `anchorFieldName` uses on a
 * FlowAnchor, read off the `by`/`value`/`name` shape `compileAnchorArgs` emits.
 */
function recordedFieldName(step: Record<string, unknown>): string | undefined {
  const by = asString(step['by']);
  if (QueryBy.TESTID === by) {
    return asString(step['value']);
  }
  if (QueryBy.ROLE === by) {
    return asString(step['name']);
  }
  return undefined;
}

/** The element's source location from an action result, when the framework stamped one. */
function sourceFromResult(res: Record<string, unknown>): Record<string, unknown> | undefined {
  const source = asRecord(res['source']);
  if (typeof source['file'] !== 'string' || typeof source['line'] !== 'number') {
    return undefined;
  }
  const out: Record<string, unknown> = { file: source['file'], line: source['line'] };
  if ('number' === typeof source['column']) {
    out['column'] = source['column'];
  }
  return out;
}

/**
 * The page a session's live url is on, as a NAVIGABLE path: pathname + query + hash, with
 * Reticle's own params dropped. Undefined when the session has no url yet.
 *
 * Every recorded page comes from here: a step's page, the route a tape is cut on, and the
 * `startPath` and route `requires` of a saved flow. The pathname alone dropped the query, so a
 * journey leased on `/?showModal=login` saved `startPath: "/"`, and its replay asserted "the modal
 * is absent" on a page where the modal never opens. Under a hash router it dropped the hash too,
 * which made every page `/` (#1411).
 */
export function pageOf(url: string | undefined): string | undefined {
  if (url === undefined) {
    return undefined;
  }
  const parts = routeOfUrl(url);
  return parts === undefined ? undefined : navigablePath(parts);
}

/**
 * Did the app send a write request in this window? A step that did is saved `writes: true`, so a
 * replay does not repeat it unasked. The dev server's own traffic is not the app's.
 */
export function wroteIn(events: readonly ReticleEvent[]): boolean {
  return events.some((event) => {
    if (EventType.NET_REQUEST !== event.type) {
      return false;
    }
    const method = asString(event.data['method'])?.toUpperCase() ?? '';
    return MUTATING_METHODS.includes(method) && !isDevToolingUrl(asString(event.data['url']));
  });
}

/** `wroteIn` over a session's window, best-effort: the record must never fail the drive it records. */
export function wroteSince(
  session: { eventsSince(since: number): readonly ReticleEvent[] },
  since: number,
): boolean {
  try {
    return wroteIn(session.eventsSince(since));
  } catch {
    return false;
  }
}

/** What a saved flow could not keep, and the fix. See RecordedStep.unkeptExpect. */
export const UNKEPT_EXPECT =
  'its proved `until` names something a saved flow cannot replay (a session ref such as e12): ' +
  'name the element by testid, role and name, or text, and the check is kept';

/**
 * Capture an act into every in-flight recording, or do nothing when none is running.
 *
 * Every tool that drives the page must call this. reticle_act_and_wait did not, which is the tool
 * the documented agent recipe drives with — so "record start -> drive -> record stop -> flow_save"
 * saved a flow with zero steps.
 */
export function captureAct(
  recordings: {
    active: () => string[];
    capture: (
      step: RecordedStep,
      route?: string,
      session?: string,
      forAmbient?: RecordedStep,
    ) => void;
  },
  args: Record<string, unknown>,
  res: unknown,
  /** Where this step ran, so the ambient tape can be cut into journeys. See RecordedStep.route. */
  route?: string,
  /** The session that acted: only recordings it started take the step. */
  session?: string,
  /** The act's window sent a write request; see `wroteIn`. */
  wrote = false,
  /** The act as the ambient tape keeps it, when that differs. See RecordingStore.capture. */
  ambientArgs?: Record<string, unknown>,
): void {
  // NO `active()` gate. `RecordingStore.capture` opens the AMBIENT tape on its first step, and that
  // branch was unreachable from here: this returned early whenever nothing was open, and the only
  // thing that opened anything was `reticle_record { action: "start" }`. So the comment on `capture`
  // — "recording is a property of the system rather than a rule an agent has to remember" — was true
  // about the intent and false about the code, and every drive nobody wrapped by hand was discarded.
  //
  // That is the whole supply of regression tests this product could have had for free: few saved
  // flows are mutation-testable and few steps declare a consequence, and a drive that is never
  // recorded cannot contribute to either.
  // A click on Reticle's own panel (the HUD exposed) is not a step of the app's journey: saved, the
  // app's flow pressed Run Harness on replay, a paid drive, under an intent that never named it.
  if (true === asRecord(res)['reticleUi']) {
    return;
  }
  const step = capturedStep(args, res, route, wrote);
  const ambient =
    ambientArgs === undefined ? undefined : capturedStep(ambientArgs, res, route, wrote);
  recordings.capture(step, route, session, ambient);
}

/** One act as a recorded step, with the claim the agent declared on it. */
function capturedStep(
  args: Record<string, unknown>,
  res: unknown,
  route: string | undefined,
  wrote: boolean,
): RecordedStep {
  const step = compileActStep(args, res);
  // Keep the assertion the agent actually made. `act_and_wait { until }` IS the agent saying what
  // success means — the large majority of calls carry one — and dropping it produced a flow graded
  // "assertion-free: it will pass even if the feature is broken", which is the regression-suite
  // story failing at its last step. See enforceableExpect below.
  const declared = args['until'] ?? args['predicate'];
  const expect = enforceableExpect(declared);
  if (expect !== undefined) {
    step.expect = expect;
  } else if (declared !== undefined) {
    step.unkeptExpect = UNKEPT_EXPECT;
  }
  if (route !== undefined) {
    step.page = route;
  }
  const intent = asString(args['intent'])?.trim();
  if (intent !== undefined && intent.length > 0) {
    step.intent = intent;
  }
  if (wrote) {
    step.writes = true;
  }
  return step;
}

/**
 * Capture an act_and_wait once its verdict is known.
 *
 * The rule act_sequence keeps (#988). A recording somebody opened keeps every claim the agent
 * declared, held or not: dropping a refuted one saved a flow that replayed green on the defect it
 * had caught. The ambient tape keeps a claim only if the action made it hold (`held`), so a flow cut
 * from it never replays a claim that was never once true because of the action. The action is
 * always recorded: replay needs it to reach the next step.
 *
 * Keyed on `held`, not on `verified: yes`. A claim the action made hold under an `unknown` or a
 * contradicted verdict is still what the agent proved about the page, and dropping it left the
 * replay with no check at all. One function decides both tapes: a second rule that took the claim off the tape
 * after the fact ran before this capture, so it took the PREVIOUS step's claim, which had passed.
 */
export function captureVerdictedAct(
  recordings: Parameters<typeof captureAct>[0],
  args: Record<string, unknown>,
  res: unknown,
  route: string | undefined,
  held: boolean,
  session?: string,
  /** The act's window sent a write request; see `wroteIn`. */
  wrote = false,
): void {
  const { until: _until, predicate: _predicate, ...unproved } = args;
  captureAct(recordings, args, res, route, session, wrote, held ? undefined : unproved);
}

/** Fold a PASSING standalone assertion into the step it proved. See RecordingStore.attachExpect. */
export function captureAssertion(
  recordings: { attachExpect: (expect: Predicate, session?: string) => void },
  raw: unknown,
  session?: string,
): void {
  const expect = enforceableExpect(raw);
  if (expect !== undefined) {
    recordings.attachExpect(expect, session);
  }
}

/**
 * A declared predicate, as a recorded expectation — or nothing.
 *
 * It is now the SAME OBJECT. A step's `expect` is a `Predicate`, so what the agent declared in
 * `until` is what the flow file stores, and there is no conversion left to lose anything in.
 *
 * What was here before was a lossy round trip through a flat struct with one slot per kind. An
 * `allOf[netA, netB]` saved as one of the two with nothing said; anything the struct could not
 * express was dropped, and a filter then removed the kinds replay would not have checked anyway.
 * Every one of those was a claim the agent made and the file did not keep.
 */
function enforceableExpect(raw: unknown): Predicate | undefined {
  if (raw === undefined) {
    return undefined;
  }
  // The flow file's own schema, so capture keeps exactly what a load would accept — a predicate
  // holding a session ref is refused by both, rather than recorded here and rejected on read.
  const parsed = FlowPredicateSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Compile a single reticle_act invocation into a normalized RecordedStep using the action result. Anchor
 * priority mirrors synthesizeAnchor: a data-testid is the gold standard; failing that, the element's
 * component identity / source location (the AUTO-ANCHOR) keeps the step STABLE instead of degrading to
 * a volatile ref. Only when neither is available is the step ref-bound (in-session only).
 */
export function compileActStep(args: Record<string, unknown>, res: unknown): RecordedStep {
  const { args: compiled, stable } = compileAnchorArgs(
    asRecord(res),
    asString(args['ref']) ?? '',
    asString(args['action']) ?? '',
    replayActionArgs(args['args']),
  );
  const timeoutMs = explicitTimeoutMs(args);
  return {
    tool: ReticleTool.ACT,
    stable,
    args: compiled,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

/** Keep only the timeout shape accepted by the public tool, including an intentional zero. */
function explicitTimeoutMs(args: Record<string, unknown>): number | undefined {
  const timeoutMs = args['timeout_ms'];
  return 'number' === typeof timeoutMs &&
    Number.isFinite(timeoutMs) &&
    Number.isInteger(timeoutMs) &&
    0 <= timeoutMs
    ? timeoutMs
    : undefined;
}

/**
 * The ONE anchor chooser: testid (gold) > role+name (identifies an instance) > component/source
 * (the JSX site) > a volatile ref (in-session only).
 *
 * It is shared because it was not: `compileSequenceStep` understood only a testid, so every
 * act_sequence sub-step on a testid-less app compiled to a ref, saved as the degraded `unresolved`
 * sentinel, and drifted on every replay — while a single act on the very same element compiled a
 * perfectly stable anchor.
 */
function compileAnchorArgs(
  r: Record<string, unknown>,
  ref: string,
  action: string,
  actArgs: Record<string, unknown>,
): { args: Record<string, unknown>; stable: boolean } {
  const compiled = anchorArgs(r, ref, action, actArgs);
  // The SDK says the target holds a secret (a password input, whatever its label). Carried beside
  // the anchor so the saved flow redacts the fill by what the field IS, not by what it is called.
  if (true === r['secret']) {
    compiled.args[SECRET_FIELD_ARG] = true;
  }
  return compiled;
}

function anchorArgs(
  r: Record<string, unknown>,
  ref: string,
  action: string,
  actArgs: Record<string, unknown>,
): { args: Record<string, unknown>; stable: boolean } {
  // A document-key press with no ref ran live against no element (act-target resolves it to the
  // document), so there is nothing to anchor and nothing missing. It used to fall through to the
  // ref-bound branch with an empty ref, which saved as the degraded placeholder and drifted on every
  // replay with "add a data-testid", on a step that has no element to add one to (#1559).
  if (0 === ref.length && isGlobalPressCall({ action, args: actArgs })) {
    return {
      args: { by: QueryBy.ROLE, value: DOCUMENT_ANCHOR_ROLE, action, args: actArgs },
      stable: true,
    };
  }
  const testid = asString(r['testid']);
  const source = sourceFromResult(r);
  // Several elements carry this test id, so a replay would take the first: anchor on role and name
  // when the element has them, else keep the test id and say how many share it.
  const testidOf =
    'number' === typeof r['testidOf'] && 1 < r['testidOf'] ? r['testidOf'] : undefined;
  const named = asString(r['role']) !== undefined && asString(r['name']) !== undefined;
  if (testid !== undefined && !(testidOf !== undefined && named)) {
    // The testid anchors the step; source rides along purely so a failure can name a file. Carrying
    // both was the point of separating anchor from provenance at capture time.
    const testidArgs: Record<string, unknown> = {
      by: QueryBy.TESTID,
      value: testid,
      action,
      args: actArgs,
    };
    if (source !== undefined) {
      testidArgs['source'] = source;
    }
    if (testidOf !== undefined) {
      testidArgs['of'] = testidOf;
    }
    return { args: testidArgs, stable: true };
  }
  // Role + NAME before component: a component/source anchor names the JSX site, so every row's copy
  // of the same control collapses onto it. The accessible name separates them, and it is also the
  // only stable anchor an app with no testids has. Measured: three rows' checkboxes compiled to one
  // identical component anchor and replayed onto a single element.
  const role = asString(r['role']);
  const name = asString(r['name']);
  if (role !== undefined && name !== undefined) {
    const roleArgs: Record<string, unknown> = {
      by: QueryBy.ROLE,
      value: role,
      name,
      action,
      args: actArgs,
    };
    if (source !== undefined) {
      roleArgs['source'] = source;
    }
    if ('number' === typeof r['nth'] && 'number' === typeof r['of']) {
      roleArgs['nth'] = r['nth'];
      roleArgs['of'] = r['of'];
    }
    return { args: roleArgs, stable: true };
  }
  // A role and NO accessible name (an icon-only button): the role plus the control's position among
  // the nameless controls of that role. Without this branch the step fell to a component anchor or
  // to the stale ref, and a replay on a fresh page could not find the control again.
  if (
    role !== undefined &&
    role !== 'generic' &&
    name === undefined &&
    asString(r['component']) === undefined
  ) {
    const namelessArgs: Record<string, unknown> = {
      by: QueryBy.ROLE,
      value: role,
      action,
      args: actArgs,
    };
    if (source !== undefined) {
      namelessArgs['source'] = source;
    }
    if ('number' === typeof r['nth'] && 'number' === typeof r['of']) {
      namelessArgs['nth'] = r['nth'];
      namelessArgs['of'] = r['of'];
    }
    return { args: namelessArgs, stable: true };
  }
  const component = asString(r['component']);
  if (component !== undefined || source !== undefined) {
    const componentArgs: Record<string, unknown> = { by: QueryBy.COMPONENT, action, args: actArgs };
    if (component !== undefined) {
      componentArgs['component'] = component;
    }
    if (source !== undefined) {
      componentArgs['source'] = source;
    }
    return { args: componentArgs, stable: true };
  }
  return { args: { ref, action, args: actArgs }, stable: false };
}

/**
 * Compile an reticle_act_sequence invocation, normalizing each sub-step through the SAME anchor
 * priority a single act uses (see compileAnchorArgs) — not testid-or-nothing, which is what made
 * every sequence unreplayable on an app without testids.
 */
export function compileSequenceStep(args: Record<string, unknown>, res: unknown): RecordedStep {
  const inputSteps = Array.isArray(args['steps']) ? args['steps'] : [];
  const resolved = Array.isArray(asRecord(res)['steps'])
    ? (asRecord(res)['steps'] as unknown[])
    : [];
  let stable = inputSteps.length > 0;
  const subSteps = inputSteps.flatMap((raw, i) => {
    // A step on Reticle's own panel is not a step of the app's journey, as for a single act.
    if (true === asRecord(resolved[i])['reticleUi']) {
      return [];
    }
    const step = asRecord(raw);
    const compiled = compileAnchorArgs(
      asRecord(resolved[i]),
      asString(step['ref']) ?? '',
      asString(step['action']) ?? '',
      replayActionArgs(step['args']),
    );
    if (!compiled.stable) {
      stable = false;
    }
    // Each sub-step keeps its OWN declared consequence. A sequence records one step and replays as
    // one batch, but what each step CLAIMED is per step -- folding them together would let one
    // signal answer for every click in the journey.
    const expect = enforceableExpect(step['expect']);
    return [expect === undefined ? compiled.args : { ...compiled.args, expect }];
  });
  const timeoutMs = explicitTimeoutMs(args);
  return {
    tool: ReticleTool.ACT_SEQUENCE,
    stable,
    args: { steps: subSteps },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

/**
 * Resolve a recorded step's element to a live ref, by whichever anchor the compiler chose.
 *
 * Every anchor the compiler can EMIT must be resolvable here. It could not be: `compileActStep`
 * emits `by: component` steps (and marks them `stable: true`), and this function only understood
 * `testid` — so every component-anchored step failed with "no testid or ref to resolve", and the
 * `stable` flag on it was a claim the replayer could not honour. Measured on a console with 5 steps:
 * the 2 with testids replayed, the 3 without were unreplayable, and the flow reported ok:false at
 * the first of them.
 */
async function resolveRef(
  session: Session,
  step: {
    by?: unknown;
    value?: unknown;
    ref?: unknown;
    name?: unknown;
    component?: unknown;
    source?: unknown;
    nth?: unknown;
    of?: unknown;
    action?: unknown;
    args?: unknown;
  },
): Promise<{ ref: string; note?: string }> {
  // Dispatched the way it ran live: at the document, with no ref. See compileAnchorArgs.
  if (isDocumentPress(step)) {
    return { ref: '' };
  }
  const by = asString(step.by);
  const value = asString(step.value);
  if (by === QueryBy.TESTID && value !== undefined) {
    const result = await session.command(ReticleCommand.QUERY, { by, value });
    if (!result.ok) {
      throw new Error(result.error ?? 'query failed');
    }
    const refs = queryRefs(result);
    const ref = refs[0];
    if (ref === undefined) {
      throw new Error(`testid '${value}' did not resolve in current page`);
    }
    return refs.length > 1 ? { ref, note: ambiguousTestidNote(value) } : { ref };
  }
  // Role + accessible NAME: the anchor that distinguishes one row's control from another's, which
  // neither a testid-less app nor a shared JSX source location can do.
  if (by === QueryBy.ROLE && value !== undefined) {
    const name = asString(step.name);
    const query: Record<string, unknown> = { by, value, ...(name === undefined ? {} : { name }) };
    const result = await session.command(ReticleCommand.QUERY, query);
    if (!result.ok) {
      throw new Error(result.error ?? 'query failed');
    }
    const refs = name === undefined ? namelessRefs(result) : queryRefs(result);
    const meant = refFor(step, refs);
    const ref = meant ?? refs[0];
    if (ref === undefined) {
      throw new Error(
        name === undefined
          ? `no ${value} with no accessible name resolved in current page`
          : `${value} named '${String(name)}' did not resolve in current page`,
      );
    }
    return meant === undefined ? { ref, note: ambiguousRoleNote(value, String(name)) } : { ref };
  }
  if (by === QueryBy.COMPONENT) {
    const component = asString(step.component);
    const source = step.source;
    const query: Record<string, unknown> = {
      by,
      ...(component === undefined ? {} : { component, value: component }),
      ...(source === undefined ? {} : { source }),
    };
    const result = await session.command(ReticleCommand.QUERY, query);
    if (!result.ok) {
      throw new Error(result.error ?? 'query failed');
    }
    const refs = queryRefs(result);
    const ref = refs[0];
    if (ref === undefined) {
      throw new Error(`component '${String(component)}' did not resolve in current page`);
    }
    // A source location identifies a JSX SITE, not an instance: one `<input>` inside a row renders
    // once per row and every one of them shares this anchor. Saying so is the difference between a
    // replay that repeated itself and a replay that reports it might have.
    return refs.length > 1
      ? {
          ref,
          note: `component anchor matched ${String(refs.length)} elements — replayed the first`,
        }
      : { ref };
  }
  const ref = asString(step.ref);
  if (ref === undefined || 0 === ref.length) {
    throw new Error('step has no resolvable anchor (testid, role+name, component) and no ref');
  }
  return { ref, note: 'replayed by stale ref (not portable across sessions)' };
}

/**
 * A compiled step that presses a document key at no element (#1559).
 *
 * Both halves are required. The anchor alone is not enough, because a hand-edited `role: document`
 * on a click would then dispatch that click at nothing; and the press alone is not enough, because a
 * recorded Escape aimed at a named element keeps that element.
 */
export function isDocumentPress(step: Record<string, unknown>): boolean {
  return (
    QueryBy.ROLE === step['by'] &&
    DOCUMENT_ANCHOR_ROLE === step['value'] &&
    undefined === step['name'] &&
    isGlobalPressCall({ action: step['action'], args: step['args'] })
  );
}

interface ReplayStepResult {
  tool: string;
  ok: boolean;
  error?: string;
  note?: string;
  /**
   * Where this step lives, rendered, when the program is a composite.
   *
   * `mid#0 (invoked from top#0)`. Absent for a flat program, where the position in this array is
   * already the answer and an address would be noise on every step of every replay.
   */
  at?: string;
}

/** Re-execute every step of a compiled program in order, stopping at the first failure. */
export async function replayProgram(
  session: Session,
  program: CompiledProgram,
  confirmDangerous = false,
  /**
   * How to find an invoked document. Absent means this replayer cannot follow one — and an
   * unfollowable invocation FAILS rather than being skipped, because a composite that reports green
   * having silently not run a sub-journey is the false green this layer exists to prevent, arriving
   * through the feature meant to strengthen it.
   */
  resolve?: (name: string) => CompiledProgram | undefined,
  /** The invocation chain that reached this program, nearest caller first. Empty at the top. */
  via: readonly { flow: string; step: number }[] = [],
): Promise<ReplayStepResult[]> {
  const results: ReplayStepResult[] = [];
  let index = -1;
  for (const step of program.steps) {
    index += 1;
    if (step.invoke !== undefined) {
      const site = { flow: program.name, step: index, via };
      const address = formatStepAddress(site);
      const chain = [...via.map((v) => v.flow), program.name];
      if (chain.includes(step.invoke)) {
        // Typecheck catches this at rest and the replayer does not trust it: the document set can
        // change between the check and the run, and an infinite replay is not a thing to find out
        // about live.
        results.push({
          tool: step.tool,
          ok: false,
          at: address,
          error: `invocation returns to a document already running: ${[...chain, step.invoke].join(' → ')}`,
        });
        break;
      }
      const sub = resolve?.(step.invoke);
      if (sub === undefined) {
        results.push({
          tool: step.tool,
          ok: false,
          at: address,
          error: invokedFlowMissing(step.invoke),
        });
        break;
      }
      results.push({ tool: step.tool, ok: true, at: address, note: `entered ${step.invoke}` });
      const nested = await replayProgram(session, sub, confirmDangerous, resolve, [
        { flow: program.name, step: index },
        ...via,
      ]);
      results.push(...nested);
      if (nested.some((r) => !r.ok)) {
        break;
      }
      continue;
    }
    try {
      if (step.tool === ReticleTool.ACT_SEQUENCE) {
        const subs = Array.isArray(step.args['steps']) ? step.args['steps'] : [];
        const notes: string[] = [];
        const liveSteps: { ref: string; action: string; args: Record<string, unknown> }[] = [];
        for (const raw of subs) {
          const sub = asRecord(raw);
          const { ref, note } = await resolveRef(session, sub);
          if (note !== undefined) {
            notes.push(note);
          }
          liveSteps.push({
            ref,
            action: asString(sub['action']) ?? '',
            args: replayActionArgs(sub['args'], confirmDangerous, recordedFieldName(sub)),
          });
        }
        // Attribute the step's effects to the step: unattributed effects are learned as ambient
        // churn on the regions the flow exercises, which teaches the settle oracle to ignore them.
        session.beginAction(ReticleTool.REPLAY, { steps: liveSteps.length });
        let r;
        try {
          // DIVERGENCE: replay sends one batched ACT_SEQUENCE command to the browser;
          // live (tools/act-tools.ts) sends N individual ACT commands for per-step timeout +
          // progress. A bug in either is invisible from the other.
          r = await session.command(ReticleCommand.ACT_SEQUENCE, { steps: liveSteps });
        } finally {
          session.finishAction();
        }
        results.push(buildResult(step.tool, r.ok, r.error, notes));
        if (!r.ok) {
          break;
        }
      } else {
        const { ref, note } = await resolveRef(session, step.args);
        session.beginAction(ReticleTool.REPLAY, { ref });
        let r;
        try {
          r = await session.command(ReticleCommand.ACT, {
            ref,
            action: asString(step.args['action']) ?? '',
            args: replayActionArgs(
              step.args['args'],
              confirmDangerous,
              recordedFieldName(step.args),
            ),
          });
        } finally {
          session.finishAction();
        }
        results.push(buildResult(step.tool, r.ok, r.error, note !== undefined ? [note] : []));
        if (!r.ok) {
          break;
        }
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
  if (!ok) {
    base.error = error ?? 'command failed';
  }
  if (notes.length > 0) {
    base.note = notes.join('; ');
  }
  return base;
}
