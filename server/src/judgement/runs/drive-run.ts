/**
 * A live drive is a verification, and until now it left no artifact.
 *
 * Reported from the field, and confirmed in the transcript: a session drove the app hard, many
 * `reticle_act_and_wait` and `reticle_assert` calls, every one producing a verdict — and the
 * dashboard stayed empty, with `lastPushAt: null` throughout. Nothing was broken. `diskSource.runs()` reads `.reticle/runs/`, and
 * the ONLY writer of that directory was the flow-replay path, so a run artifact existed if and only
 * if somebody had recorded a flow and replayed it. Every verdict produced by driving the app — which
 * is the entire product experience — was local and stayed local.
 *
 * So this folds the session's journal into the same artifact the replay path writes, and the sync
 * daemon that was already running picks it up with no other change.
 *
 * ── WHAT IT WRITES DOWN ─────────────────────────────────────────────────────────────────────────
 * Every verdict, in the words it was given. `unknown` ("I could not tell") and `no-fault` ("nothing
 * was declared to prove") are neither pass nor fail, and this used to drop them, because the check
 * outcome on disk was binary and had no spelling for either. They were counted in a sentence in the
 * trigger note instead.
 *
 * That was the product's own failure mode wearing our clothes. A reader of the artifact saw only
 * the verdicts we happened to be able to spell, and "I could not see" left the document. The
 * outcome is four-valued now, so all four are recorded, and the run verdict counts an undetermined
 * check as neither a pass nor a failure -- which is what those words already meant everywhere else.
 */

import { supersededChecks } from '@reticlehq/engine/evidence/superseded-checks.js';
import type { JournalVerdictEffect } from '@reticlehq/core/artifacts';
import { isValidRunId } from '@/memory/project/dir/reticle-dir.js';
import { defaultRunId } from './runner-port.js';
import { currentShotRun, stableRunId } from './default-run-id.js';
import { currentDrivenBy } from '@/hooks/driven-by.js';
import {
  JournalVerdictEffectSchema,
  RunAgentKind,
  asRecord,
  asString,
  RunFramework,
  RunProfile,
  RunTrigger,
  PredicateKind,
  Verified,
  VerifiedReason,
  driveFlowStatus,
  type DrivenBy,
  type VerdictStatus,
  type JournalAction,
  type RunCheck,
  type RunDisparity,
} from '@reticlehq/core';
import type { VerificationRunInput } from './artifact/build-verification-run.js';
import { withCorrections } from './late-answer.js';

/** The author of record when no MCP peer introduced itself. Mirrors verification-sync's default. */
const UNNAMED_AGENT = 'reticle-mcp';

export interface DriveRunDeps {
  /** The project's folder name, for a tab that reported no project id. */
  projectName?: string | undefined;
  runId: string;
  /** The project this session belonged to, for the dashboard's row. */
  projectId?: string | undefined;
  /** The MCP client's own claim from the handshake, when it made one. */
  agentId?: string | undefined;
  framework?: RunFramework | undefined;
  /**
   * Which round of source edits this drive's evidence belongs to.
   *
   * Passed in rather than derived, because the session knows it and a fold over the journal cannot.
   * Absent when nobody was counting edits, which must not be reported as "the first round".
   */
  editEpoch?: number | undefined;
  /** Where each agent session in the tab ended (`agentEndCounts`): each is folded on its own. */
  agentEnds?: readonly number[];
  /** What the agent claimed at each of those ends (`agentEndClaims`), by the same index. */
  agentClaims?: readonly (VerdictStatus | undefined)[];
  /** The agent's own claim for this run, carried beside the graded verdict. */
  agentClaim?: VerdictStatus | undefined;
}

/**
 * The one MCP client every stamped action came from. Two clients in one tab is undefined, never a
 * pick: crediting either would put the other's verdicts under its name.
 */
function soleAgent(actions: readonly JournalAction[]): string | undefined {
  const named = new Set(
    actions.flatMap((action) => (action.agent === undefined ? [] : [action.agent])),
  );
  return 1 === named.size ? [...named][0] : undefined;
}

/**
 * What a verdict required and what it saw, as the journal keeps them for its check. One place, so
 * the act and assert paths cannot keep different halves.
 */
export function checkWords(verdict: { expected?: string; observed?: string }): {
  expected?: string;
  observed?: string;
} {
  return {
    ...(verdict.expected === undefined ? {} : { expected: verdict.expected }),
    ...(verdict.observed === undefined ? {} : { observed: verdict.observed }),
  };
}

/** Every verdict a verification tool recorded on this session's actions, in order. */
function verdicts(
  actions: readonly JournalAction[],
): (JournalVerdictEffect & { actionId: string })[] {
  const out: (JournalVerdictEffect & { actionId: string })[] = [];
  for (const action of actions) {
    const parsed = JournalVerdictEffectSchema.safeParse(action.effect);
    if (parsed.success) out.push({ ...parsed.data, actionId: action.actionId });
  }
  return out;
}

/**
 * The elapsed span the drive covered, from the journal's own clock.
 *
 * Journal timestamps are elapsed-ms from session start, so the last one IS the duration. Zero when
 * nothing was recorded — never `Date.now()`, which is not this session's clock and would report the
 * age of the process.
 */
function spanOf(actions: readonly JournalAction[]): number {
  return actions.reduce((max, action) => (action.at > max ? action.at : max), 0);
}

/** Marks a run as the fold of a live drive rather than a flow replay, and keeps ids from colliding. */
const DRIVE_RUN_PREFIX = 'drive-';

/**
 * The run id for a session's drive: stable, so the session rewrites its own row.
 *
 * Session teardown fires on every socket close, and a reconnecting tab keeps its session id and
 * keeps appending to the same journal. A random id per teardown would therefore publish one row per
 * reload, each a superset of the last, and the dashboard would fill with overlapping copies of one
 * drive. Derived from the session instead, so the fold is idempotent.
 *
 * A hash of the session id, not the id itself. A session id is a free string on the wire, and a
 * uuid one put 36 characters into every step screenshot path. The hash is short, stable and always
 * a safe path segment. A run that an older daemon wrote keeps its long id and stays readable.
 */
export function driveRunId(sessionId: string): string {
  return `${DRIVE_RUN_PREFIX}${stableRunId(sessionId)}`;
}

/** The run of the `segment`th agent session in a tab: the tab's id first, then `-2`, `-3`… */
function segmentRunId(base: string, segment: number): string {
  if (0 === segment) return base;
  const id = `${base}-${String(segment + 1)}`;
  return isValidRunId(id) ? id : base;
}

/**
 * Where each agent session in a tab ended: how many of the agent's own actions the tab held then,
 * and the tab's clock. Every agent session in a tab wrote one run id, so a later end overwrote the
 * earlier run on the dashboard.
 * ponytail: daemon memory; a restart forgets the ends and the next fold is one run, as before.
 */
const agentEnds = new Map<string, { count: number; at: number; claim?: VerdictStatus }[]>();

/** The agent's own actions: the Harness drives in the same tab are runs of their own. */
const agentsOwn = (actions: readonly JournalAction[]): JournalAction[] =>
  actions.filter((action) => action.drivenBy === undefined);

/** The run the agent's session now open in this tab is kept under. */
export function agentRunId(sessionId: string): string {
  return segmentRunId(driveRunId(sessionId), agentEnds.get(sessionId)?.length ?? 0);
}

/**
 * The run the current call lands in: the flow being replayed, else the Harness drive, else the
 * agent session open in the tab. One answer for a call's screenshot and an intent its check proves.
 */
export function runIdOfCall(sessionId: string): string {
  const scoped = currentShotRun();
  if (scoped !== undefined) return scoped;
  const by = currentDrivenBy();
  const harness = by === undefined ? undefined : harnessRunId(by.harness);
  return harness ?? agentRunId(sessionId);
}

/** The ends recorded for a tab, as counts of the agent's own actions, for the fold. */
export function agentEndCounts(sessionId: string): number[] {
  return (agentEnds.get(sessionId) ?? []).map((end) => end.count);
}

/** What the agent claimed at each end of a tab, by the index `agentEndCounts` uses. */
export function agentEndClaims(sessionId: string): (VerdictStatus | undefined)[] {
  return (agentEnds.get(sessionId) ?? []).map((end) => end.claim);
}

/**
 * An agent session ends: its own actions since the previous end, the run they are kept under, and
 * how long it ran. Recorded, so what the agent drives next is the next session's.
 */
export function endAgentSession(
  sessionId: string,
  actions: readonly JournalAction[],
  at: number | undefined,
  claim?: VerdictStatus,
): { actions: JournalAction[]; runId: string; wallMs?: number } {
  const own = agentsOwn(actions);
  const ends = agentEnds.get(sessionId) ?? [];
  const last = ends.at(-1);
  const runId = agentRunId(sessionId);
  ends.push({
    count: own.length,
    at: at ?? last?.at ?? 0,
    ...(claim === undefined ? {} : { claim }),
  });
  agentEnds.set(sessionId, ends);
  // The end splits the tab's runs: written again now, not when the tab disconnects, so the run this
  // end names is on disk (and the dashboard) while the tab stays open.
  tellNoted();
  const mine = own.slice(Math.min(last?.count ?? 0, own.length));
  const wallMs = at === undefined ? undefined : wallOf(mine, last?.at, at);
  return { actions: mine, runId, ...(wallMs === undefined ? {} : { wallMs }) };
}

/**
 * How long a session ran, `since` the previous end (else its first action) to `end`, on the tab's
 * clock, which restarts at every page load: an action stamped before the one ahead of it starts a
 * new stretch, and the stretches add up. Measured from the last load alone, a ten-second session
 * that navigated read "1.2s". ponytail: the gap between a reload and the next action is not counted.
 */
function wallOf(actions: readonly JournalAction[], since: number | undefined, end: number): number {
  let start = since ?? actions[0]?.tRange.from ?? end;
  let prev = start;
  let total = 0;
  for (const action of actions) {
    if (action.at < prev) {
      total += prev - start;
      start = action.tRange.from;
    }
    prev = action.at;
  }
  return total + (prev <= end ? end - start : prev - start + end);
}

/**
 * Fold a session's journal into a run, or return undefined when there is nothing honest to report.
 *
 * Pure: it takes the ledger and returns the artifact input. Reading the ledger and writing the
 * artifact are the caller's job, which is what keeps the verdict rules testable without a disk.
 */
export function driveRunFrom(
  actions: readonly JournalAction[],
  deps: DriveRunDeps,
): VerificationRunInput | undefined {
  const found = verdicts(actions);
  const intentOf = new Map(actions.map((a) => [a.actionId, asString(asRecord(a.args)['intent'])]));
  const checks: RunCheck[] = [];
  for (const verdict of found) {
    // The agent's own words on the call win; else the sentence the verdict recorded.
    const given = intentOf.get(verdict.actionId);
    const own = given !== undefined && 0 < given.length;
    const intent = own ? given : verdict.intent;
    checks.push({
      predicate: verdict.claim,
      status: verdict.verified,
      actionId: verdict.actionId,
      ...(intent === undefined || 0 === intent.length ? {} : { intent }),
      ...(!own && true === verdict.intentDerived ? { intentDerived: true } : {}),
      ...(verdict.failedPart === undefined ? {} : { failedPart: verdict.failedPart }),
      // Where it was written, and on a miss the calls of its window: what an issue page shows.
      ...(verdict.source === undefined && verdict.net === undefined
        ? {}
        : {
            evidence: {
              ...(verdict.source === undefined ? {} : { source: verdict.source }),
              ...(verdict.net === undefined ? {} : { net: verdict.net }),
            },
          }),
      // What it required and what it saw, so a failed check can say both on the platform.
      ...(verdict.expected === undefined ? {} : { expected: verdict.expected }),
      ...(verdict.observed === undefined ? {} : { observed: verdict.observed }),
      // Carried through rather than recomputed. These were established at the moment the verdict
      // was made and written down then; a run built later cannot know any of them, and inferring
      // them here would be inventing evidence about evidence.
      //
      // `kind` was the one field that rule was not applied to: it was stamped `element` on every
      // check ever folded, including the ones whose `grade` in the same object said `net`. A
      // journal old enough to have no kind now produces a check with no kind, which is the honest
      // answer -- a missing field, rather than a wrong one nothing downstream can question.
      ...(verdict.kind === undefined ? {} : { kind: verdict.kind }),
      ...(verdict.declaredBeforeActing === undefined
        ? {}
        : { declaredBeforeActing: verdict.declaredBeforeActing }),
      ...(verdict.grade === undefined ? {} : { grade: verdict.grade }),
      ...(verdict.couldNotSee === undefined ? {} : { couldNotSee: verdict.couldNotSee }),
      // Kept so the fold below can tell a question that is still open from one that was never
      // answerable. Both are `unknown`; only one of them can be corrected later.
      ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
    });
  }
  // A session that never verified anything has nothing to report, and saying so on a dashboard every
  // time somebody opens an app would be noise. A session that DID verify and resolved none of it is
  // the opposite: it is the thing they most need to see -- and those checks are now in the list
  // rather than counted in a sentence, so the row shows what happened instead of alluding to it.
  if (0 === checks.length) return undefined;
  // A verdict that was open because the outcome had not arrived, and a later verdict on the same
  // claim that decided it, become a correction: the second cites the first and the first is left
  // exactly as it was given. See late-answer.ts for what does and does not count as an answer.
  const corrected = withCorrections(deps.runId, checks);
  return {
    runId: deps.runId,
    durationMs: spanOf(actions),
    profile: RunProfile.DEV,
    project: {
      // Never the daemon's own name: a tab that reported no project is named by its folder.
      name: deps.projectId ?? deps.projectName ?? UNNAMED_AGENT,
      framework: deps.framework ?? RunFramework.OTHER,
    },
    agent: {
      id: deps.agentId ?? soleAgent(actions) ?? UNNAMED_AGENT,
      kind: RunAgentKind.CODING_AGENT,
    },
    trigger: {
      kind: RunTrigger.EDIT,
      note: 'driven live through the Reticle tools',
    },
    ...(deps.editEpoch === undefined ? {} : { editEpoch: deps.editEpoch }),
    changedFiles: [],
    flows: [],
    checks: corrected,
    risks: [],
    // Empty rather than harvested. The journal holds the events, but the evidence block is a claim
    // about what was WRONG, and a fold that guessed at anomalies would be inventing findings — the
    // failure this artifact is supposed to make impossible. Checks are the evidence here.
    evidence: { consoleErrors: [], networkAnomalies: [], stateAssertions: [], timeline: [] },
    ...(deps.agentClaim === undefined ? {} : { agentClaim: deps.agentClaim }),
  };
}

/** Marks a run as one Harness drive, so it never collides with the session's own `drive-` run. */
const HARNESS_RUN_PREFIX = 'harness-';

/** What a Harness run says drove it, in the dashboard's "Driven by" line. */
export function harnessAgentId(driver: string): string {
  return 'server' === driver ? 'Reticle Harness (platform)' : `Reticle Harness (${driver})`;
}

/**
 * The id of the run a Harness drive syncs as, so whoever started the drive can find it again (the
 * platform's chat folds the run into the check it asked for). Undefined for an id no run can carry.
 */
export function harnessRunId(harness: string): string | undefined {
  const candidate = `${HARNESS_RUN_PREFIX}${harness}`;
  return isValidRunId(candidate) ? candidate : undefined;
}

/** The journey a Harness drive was named for, or what it did when nobody named one. */
// Never "Harness drive": that read as the title of every unnamed drive's flow and finding.
const UNNAMED_JOURNEY = 'Exploring the app';

/** Goal verdicts kept for the drives a session has not yet been graded on. */
const MAX_GOALS_HELD = 200;
const goalsMissed = new Map<string, boolean>();

/**
 * What the Harness judged of a drive's goal, noted the moment the drive finishes, before its
 * session ends and is graded. A drive whose checks held but whose goal was not reached synced as
 * "Proved"; it is not proved. Unmet once is unmet: a later journey of the same drive reaching its
 * goal does not undo it.
 */
/** Told when a Harness drive's goal or comparison is noted, or an agent session ends, so its run is written again. */
const noted = new Set<() => void>();

/**
 * Hear about every Harness note. A drive is graded after its last verdict, and the run that verdict
 * flushed never carried the grade: live, the platform filed a failed check instead of "Hard to find".
 */
export function onHarnessNoted(listener: () => void): () => void {
  noted.add(listener);
  return () => noted.delete(listener);
}

const tellNoted = (): void => {
  for (const listener of noted) listener();
};

/** How long each Harness drive took, timed by the drive on the injected clock. */
const spans = new Map<string, number>();

/**
 * The drive's own measure of how long it ran. The span of one tab's journal is not it: a lane in a
 * leased browser left only the grade's assert in the tab, and its run read "Took 0 ms".
 */
export function noteHarnessSpan(harness: string, ms: number): void {
  if (MAX_GOALS_HELD <= spans.size && !spans.has(harness)) {
    const oldest = spans.keys().next().value;
    if (oldest !== undefined) spans.delete(oldest);
  }
  spans.set(harness, Math.max(0, ms));
  tellNoted();
}

export function noteHarnessGoal(harness: string, met: boolean | undefined): void {
  if (met === undefined) return;
  const before = goalsMissed.get(harness);
  if (false === before) return;
  if (MAX_GOALS_HELD <= goalsMissed.size && !goalsMissed.has(harness)) {
    const oldest = goalsMissed.keys().next().value;
    if (oldest !== undefined) goalsMissed.delete(oldest);
  }
  goalsMissed.set(harness, met);
  tellNoted();
}

/** How each Harness drive's goals compared with the agent's verdicts, until its run is folded. */
const disparities = new Map<string, readonly RunDisparity[]>();

/**
 * Noted when a drive is graded, like its goal: its run artifact carries the comparison, so the
 * platform can file a goal the agent proved and the Harness could not find.
 */
export function noteHarnessDisparity(harness: string, found: readonly RunDisparity[]): void {
  if (0 === found.length) return;
  if (MAX_GOALS_HELD <= disparities.size && !disparities.has(harness)) {
    const oldest = disparities.keys().next().value;
    if (oldest !== undefined) disparities.delete(oldest);
  }
  disparities.set(harness, found);
  tellNoted();
}

/** The phrase `describeWaitTarget` opens a route claim with, as the journal records it. */
const ROUTE_CLAIM = 'a route change';
const ABSENCE_OF = 'the absence of ';

/**
 * Whether a recorded check claimed nothing but a route (or leaving one): the Harness driver's guess
 * about where a click goes, which `harness/route-guess.ts` explains. Kept here because a run fold
 * reads the journal's words, not the predicate.
 */
function claimsOnlyRoute(claim: string, kind: string | undefined): boolean {
  if (PredicateKind.ROUTE === kind) return true;
  return PredicateKind.NOT === kind && claim.startsWith(`${ABSENCE_OF}${ROUTE_CLAIM}`);
}

/**
 * One Harness drive, as its own run: named for the journey it was asked to complete, and credited to
 * the Harness rather than to the agent whose tab it shared. The journey reads as one flow, graded by
 * `driveFlowStatus`: failed only on a check that came back no.
 */
function harnessRunFrom(
  by: DrivenBy,
  actions: readonly JournalAction[],
  deps: DriveRunDeps,
): VerificationRunInput | undefined {
  const input = driveRunFrom(actions, {
    ...deps,
    runId: harnessRunId(by.harness) ?? defaultRunId(),
  });
  if (input === undefined) return undefined;
  // The driver's own wrong guess about where a click goes is not a failed check of the app; nor is
  // its second press of a control whose claim already held (Save again on a field the app emptied).
  const refOf = new Map(actions.map((a) => [a.actionId, asString(asRecord(a.args)['ref'])]));
  const heldBefore = new Set<string>();
  const checks = input.checks.map((check) => {
    const ref = check.actionId === undefined ? undefined : refOf.get(check.actionId);
    const key = ref === undefined ? undefined : `${ref}|${check.predicate}`;
    const repress = Verified.NO === check.status && key !== undefined && heldBefore.has(key);
    if (Verified.YES === check.status && key !== undefined) heldBefore.add(key);
    return Verified.NO === check.status && (repress || claimsOnlyRoute(check.predicate, check.kind))
      ? { ...check, status: Verified.UNKNOWN, reason: VerifiedReason.INCONCLUSIVE }
      : check;
  });
  // A passive check that read too early is not counted: the one rule (superseded-checks.ts).
  const superseded = supersededChecks(
    input.checks.map((c) => ({
      key: c.predicate,
      passive: false === c.declaredBeforeActing,
      held: Verified.YES === c.status,
      failed: Verified.NO === c.status,
    })),
  );
  const count = (verified: string): number =>
    checks.filter((check, at) => verified === check.status && !superseded.has(at)).length;
  const status = driveFlowStatus({
    held: count(Verified.YES),
    failed: count(Verified.NO),
    goalMet: goalsMissed.get(by.harness),
  });
  const first = actions.reduce((min, action) => Math.min(min, action.at), Number.MAX_SAFE_INTEGER);
  const durationMs = spans.get(by.harness) ?? Math.max(0, input.durationMs - first);
  return {
    ...input,
    checks,
    ...(disparities.has(by.harness) ? { disparity: [...(disparities.get(by.harness) ?? [])] } : {}),
    durationMs,
    agent: { id: harnessAgentId(by.driver), kind: RunAgentKind.CODING_AGENT },
    trigger: {
      kind: RunTrigger.EDIT,
      note: `driven by the Harness${by.persona === undefined ? '' : `: ${by.persona}`}`,
    },
    flows: [
      {
        name: by.persona ?? UNNAMED_JOURNEY,
        status,
        steps: actions.length,
        durationMs,
      },
    ],
  };
}

/**
 * Every run a session's journal holds: the connected agent's drive, and one per Harness drive.
 *
 * They used to be one. A Harness drive dispatches through the same tools in the same tab, so its
 * verdicts folded into the agent's run, and the dashboard showed one blended row that credited the
 * agent with what the Harness proved and named neither.
 */
export function driveRunsFrom(
  actions: readonly JournalAction[],
  deps: DriveRunDeps,
): VerificationRunInput[] {
  const own = agentsOwn(actions);
  // Each agent session in the tab is its own run: cut at the ends `reticle_session {end}` recorded.
  const cuts = [0, ...(deps.agentEnds ?? []).map((n) => Math.min(n, own.length)), own.length];
  const sessions = cuts.slice(1).map((to, i) =>
    driveRunFrom(own.slice(cuts[i] ?? 0, to), {
      ...deps,
      runId: segmentRunId(deps.runId, i),
      agentClaim: deps.agentClaims?.[i],
    }),
  );
  const drives = new Map<string, { by: DrivenBy; actions: JournalAction[] }>();
  for (const action of actions) {
    const by = action.drivenBy;
    if (by === undefined) continue;
    const held = drives.get(by.harness) ?? { by, actions: [] };
    held.actions.push(action);
    drives.set(by.harness, held);
  }
  return [
    ...sessions,
    ...[...drives.values()].map((drive) => harnessRunFrom(drive.by, drive.actions, deps)),
  ].filter((run): run is VerificationRunInput => run !== undefined);
}
