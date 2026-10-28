import { takeCallSecrets, withCallSecrets } from './tool-kit.js';
import { healthEnvelope } from '@/portal/session/session-health.js';
import { sdkBehindNote } from '@/portal/session/session-info.js';
import { logToolCall, toolLogPath } from '@/hooks/tool-log.js';
import { nextStep } from './next-step.js';
import { currentDrivenBy } from '@/hooks/driven-by.js';
import { agentNameOf, agentSessionOf, runAsAgent } from '@/hooks/coding-agents.js';
import { recordEpisodeCall } from '@/memory/journal/episode-log.js';
import { takeHumanNotes } from './human-notes.js';
import { takeDriveNotes } from '@/features/harness/drive-runs.js';
import { harnessDriving, msgHarnessHasTheTab } from './harness-tab-guard.js';
import { sessionRoot, sessionTarget } from '@/memory/project/session-root.js';
import { ArtifactRootReason } from '@/memory/project/artifact-root.js';
import { agentNudge, takePlatformMoment } from './platform-moment.js';
import { RESULT_FIELD, trackVerdict } from './reticle-result.js';
import { endsRun, noteToolResult, runReportField } from './run-report.js';
import { runLedger } from '@/judgement/runs/run-ledger.js';
import { readAppNotes } from './agent/app-notes.js';
import { forTheAgent } from './agent/for-the-agent.js';
import { type NoticeFold, feedbackAlreadyAsked, noteFeedbackAsked } from './agent/notices.js';
import { SKEW_SHORT_WARNING, SKEW_VERDICT_WARNING } from '@/portal/session/session-health.js';
import { verifyNextBaton, SUPPRESS_VERIFY_NEXT_ENV } from './verify-next-baton.js';
import {
  type BrowserBrand,
  TelemetryActor,
  TelemetryEventKind,
  THROTTLED_WARNING,
  TRANSPORT_LIMITS,
  fingerprintFinding,
} from '@reticlehq/core';
import { getSessionMetrics } from '@/telemetry/session-metrics.js';
import { getTelemetry } from '@/telemetry/telemetry.js';
import { takeUpdateNudge } from '@/command/update/update-nudge.js';
import { takeVersionSkew } from '@/command/version/version-nudge.js';
import { rewriteClosedAsSkew } from '@/command/version/version-skew.js';
import { noteToolCall } from '@/command/daemon/lifetime/daemon-usefulness.js';
import { bugsInResult, routeOf } from '@/telemetry/bug-found.js';
import { noteToolServed, reportToolRefused } from '@/telemetry/tool-refused.js';
import { buildErrorPayload, codedRefusalOf, refusalReasonFor } from './error-recovery.js';
import { resultIsError } from '@/surface/mcp/faults/mcp-is-error.js';
import { verificationOf } from '@/telemetry/verification-of.js';
import { emitBugFoundHook, emitVerdictHook } from '@/hooks/hook-emit.js';
import {
  noteActed,
  noteFirstVerdict,
  noteNextCall,
  noteOnboardingFirst,
  noteVerdictProduced,
} from '@/telemetry/onboarding-firsts.js';
import { DiscoveryInvite, isPlainRecord as isPlainObject } from '@reticlehq/core';
import { SESSION_ID_ARG, sessionIdFromArgs, spentRefFromArgs } from './tools-helpers.js';
import {
  ACTION_TOOLS,
  CDP_TOOLS,
  EnvelopeKey,
  HOST_STUB_NOTE,
  REF_MINTING_TOOLS,
  SESSION_BOUND_TOOLS,
  STEP_SHOT_TOOLS,
} from './tool-kit.js';
import { ReticleTool } from '@reticlehq/core';
import { takeFeedbackPrompt } from './feedback-tools.js';
import { takeFeedbackUndelivered } from '@/telemetry/feedback-delivery.js';
import type { Session } from '@/portal/session/session.js';
import { noteRefsMinted, wrongTabRefusal } from '@/portal/session/facts/ref-provenance.js';
import { span } from '@/trace.js';
import { takeStepShot } from '@/features/visual/step-shots.js';
import {
  defectForToolResult,
  deltaForToolResult,
  impactSnapshot,
  initImpact,
  recordImpact,
} from '@/memory/impact/impact-recorder.js';
import { FrictionKind, frictionOf, inviteFor } from './feedback-invite.js';
import { VACUOUS_BECAUSE } from '@reticlehq/engine/evidence/verified.js';
import type { ToolCall, ToolDef, ToolDeps } from './tool-kit.js';

/**
 * Emit `verification_completed` when a verification tool produced a verdict.
 *
 * Read off the RESULT here rather than emitted from `decideVerified`, which is where the verdict is
 * actually decided: that function is pure, and the repo's rules keep clocks, IO and side effects out
 * of pure logic for good reason. Reading the result also means all the verification tools are covered
 * by one site instead of N handler edits, and the next one is covered the moment it joins the set.
 *
 * The RULE itself lives in verification-of.ts, because getting it wrong fails silently.
 */
function recordVerification(
  toolName: string,
  result: Record<string, unknown>,
  durationMs: number,
  brand: BrowserBrand | undefined,
  sessionId: string | undefined,
  sdkVersion: string | undefined,
): boolean {
  const verification = verificationOf(
    toolName,
    result,
    durationMs,
    brand,
    currentDrivenBy() !== undefined,
    sdkVersion,
  );
  if (verification === undefined) {
    return false;
  }
  getSessionMetrics().recordVerification();
  void getTelemetry().emit(TelemetryEventKind.VERIFICATION_COMPLETED, {
    actor: TelemetryActor.AGENT,
    verification,
  });
  // The public half of the same moment. Nothing before this marks a user's own app actually being
  // verified: `init_completed` fires when files are written, minutes earlier.
  //
  // Emitted from the site that already decided a verdict happened, so the two can never disagree —
  // a second listener deciding for itself is a second thing that can stop firing.
  //
  // Idempotency is deliberately NOT applied: the step is per verdict, and a session that proves ten
  // things is a different shape from one that proves one.
  emitVerdictHook(toolName, result, verification.verified, sessionId);
  // The ONBOARD half of the same moment: the first verdict of this run, once.
  noteFirstVerdict();
  // The FIRST_RUN rung: once per machine + project, not once per verdict.
  noteVerdictProduced(durationMs);
  return true;
}

/**
 * Emit one `bug_found` per defect in a tool result, and count it into the session.
 *
 * The outcome metric: everything else measures whether Reticle is used, this measures whether it
 * works. Discrete events rather than only a counter, because the KIND distribution is the argument —
 * "we found 4,000 bugs" is a claim, "1,200 were greens that lied" is evidence.
 */
function reportBugsFound(
  toolName: string,
  result: Record<string, unknown>,
  sessionId: string | undefined,
): void {
  const bugs = bugsInResult(toolName, result);
  if (0 === bugs.length) {
    return;
  }
  const metrics = getSessionMetrics();
  const route = routeOf(result);
  for (const bug of bugs) {
    // `recordBug` answers whether this kind is new to the session, which is the only thing that
    // separates "another defect" from "the same defect again". Counting instances as defects is how
    // a published number inflates itself.
    const first = metrics.recordBug(bug.kind);
    const identity =
      route !== undefined
        ? { kind: bug.kind, source: bug.source, route }
        : { kind: bug.kind, source: bug.source };
    const fingerprint = fingerprintFinding(identity);
    const occurrence = metrics.recordBugOccurrence(fingerprint);
    void getTelemetry().emit(TelemetryEventKind.BUG_FOUND, {
      actor: TelemetryActor.AGENT,
      bug: {
        ...bug,
        repeat: !first,
        fingerprint,
        ...(occurrence === undefined ? {} : { occurrence }),
      },
    });
    // The same defect, said out loud to whoever is building on Reticle. Inside the loop rather than
    // after it because the event is PER DEFECT — one event carrying a list would make a consumer
    // unpack it to answer "what was found", which is the question they are subscribing to ask.
    emitBugFoundHook(toolName, bug, { repeat: !first, fingerprint, route, sessionId });
  }
}

/**
 * Report a refused call, at the one place both dispatch paths cross.
 *
 * A refusal arrives two ways and they are the same event: the handler THROWS (the common case — no
 * session, a stale ref, a schema rejection), or it RETURNS `{ error }`, which is this codebase's
 * refusal convention and just as much a refusal. Both are classified by the same table the agent's
 * recovery advice comes from, so the reason we record and the advice it got cannot describe
 * different things.
 *
 * `reticle_run` is skipped for the same reason `bugsInResult` skips it: it is a WRAPPER whose
 * handler calls `runTool` on the real tool, which already reported that refusal under the real
 * tool's name, and then hands the same failure back out to be reported a second time as
 * `reticle_run`. A count that doubles because of HOW a tool was reached is not a measurement.
 */
function reportRefusal(
  toolName: string,
  args: Record<string, unknown>,
  message: string,
  error?: unknown,
): void {
  if (toolName === ReticleTool.RUN) {
    return;
  }
  reportToolRefused(toolName, refusalReasonFor(message, codedRefusalOf(error)), args);
}

/**
 * Which friction this result represents, counting the invitation if there is one.
 *
 * Feedback is the highest-yield channel this product has, and `feedbackPrompted` is the denominator
 * that says whether inviting mid-task works or is decoration. It read as near-empty because the
 * count sat behind the session-bound early return, so a session-EXEMPT tool never invited and a tool
 * that THREW never got there — and a throw is the commonest refusal there is.
 *
 * `reticle_run` is skipped for the same reason it is skipped for refusals and defects: the wrapper's
 * handler calls `runTool` on the real tool, which already invited under the real tool's name, and
 * the failure is then handed back out to be counted a second time. A doubled denominator makes the
 * feedback rate read half.
 */
function frictionInviteFor(toolName: string, raw: unknown): FrictionKind | undefined {
  if (!isPlainObject(raw) || toolName === ReticleTool.RUN) {
    return undefined;
  }
  const friction = frictionOf({
    unknownTool: false,
    // A vacuous unknown is the caller's: it asserted nothing real (a bare `settled` wait, which the
    // instructions recommend). Inviting a bug report there told agents Reticle had failed them.
    verifiedUnknown: 'unknown' === raw['verified'] && VACUOUS_BECAUSE !== raw['because'],
    repeatRun: getSessionMetrics().currentRun,
    errored: resultIsError(raw),
    // A verdict is progress. Without this, three successful act_and_wait calls in a row — the exact
    // loop this release exists to encourage — get told they are stuck.
    producedVerdict: 'verified' in raw,
  });
  if (friction !== undefined) {
    getSessionMetrics().recordFeedbackPrompt();
  }
  return friction;
}

/**
 * The single entry point both the MCP server and the programmatic invoker call instead of
 * `tool.handler` directly. Runs the handler, then — for a live-session tool returning a plain
 * object that did not already include `session` — splices the health envelope on. Idempotent
 * (handlers that already add health are left untouched) and never alters non-object results.
 */
/**
 * The name of the first argument whose string value exceeds the transport bound, if any.
 *
 * One level of nesting is searched because that is where callers put payloads — `reticle_act`'s
 * `args.value`, and the fuzz's own `huge-string` shape. Deeper recursion would cost more than it
 * buys: the failure is a single huge string, not a deeply nested structure of small ones.
 */
function firstOversizedArg(args: Record<string, unknown>): string | undefined {
  const tooLong = (value: unknown): boolean =>
    'string' === typeof value && value.length > TRANSPORT_LIMITS.MAX_STRING_LENGTH;
  for (const [key, value] of Object.entries(args)) {
    if (tooLong(value)) {
      return key;
    }
    if ('object' === typeof value && null !== value && !Array.isArray(value)) {
      for (const [inner, nested] of Object.entries(value as Record<string, unknown>)) {
        if (tooLong(nested)) {
          return `${key}.${inner}`;
        }
      }
    }
  }
  return undefined;
}

/**
 * The args the handler is dispatched with, pinned to the session THIS call resolved.
 *
 * `runTool` resolves the session once and then attributes the whole call to it: the pool lease it
 * refreshes, the health envelope it splices, the tab a ref is recorded as minted in, the project
 * ledger the call lands in, the session a verdict is reported under. The handler was then handed
 * the caller's args untouched, so a call that named no `sessionId` resolved a SECOND time — and a
 * tab that connects in between can win auto-selection on its fresher heartbeat. The action goes to
 * one tab and the answer describes another, which is a verdict about a page that was never driven
 * and reads exactly like a correct one (#983).
 *
 * The wrong-tab ref guard is the sharpest case: it is asked whether the ref belongs to the tab
 * resolution picked, so its permission is only sound if that is also the tab the handler drives.
 *
 * A COPY, never a write into the caller's object. `reticle_run`, the merged families and the
 * programmatic invoker all pass the same record on, and a dispatch decision leaking back into it
 * would outlive this call.
 *
 * Only a GUESSED session is pinned. An explicit id — including one lifted off a sequence step — is
 * passed through exactly as written, so whether a stale id refuses or rebinds stays the resolver's
 * decision; and a tool no session was resolved for (disk-only tools, or nothing connected) is left
 * unscoped, so it answers as it always did.
 */
function pinnedArgs(
  args: Record<string, unknown>,
  explicitSessionId: string | undefined,
  session: Session | undefined,
): Record<string, unknown> {
  if (explicitSessionId !== undefined || session === undefined) {
    return args;
  }
  return { ...args, [SESSION_ID_ARG]: session.id };
}

export async function runTool<Ext>(
  tool: ToolDef<Ext>,
  deps: ToolDeps<Ext>,
  given: Record<string, unknown>,
  call?: ToolCall,
): Promise<unknown> {
  // A replay's secrets leave the arguments here, before the tool log, the journal or telemetry can
  // see them, and are supplied to this call alone.
  const { secrets, rest: args } = takeCallSecrets(given);
  // A verdict still being decided is waited for by a session end (`trackVerdict`); the result is
  // compacted for the agent last, after telemetry and the tool log have read the full result.
  return trackVerdict(
    tool.name,
    withCallSecrets(secrets, async () => {
      // The agent's own calls make its run; `reticle_run` is counted once, as the tool it reached.
      // A host that wires no clock (an embedding, a test double) gets no report, never an error.
      const agentCall =
        currentDrivenBy() === undefined &&
        deps.attachId !== undefined &&
        ReticleTool.RUN !== tool.name &&
        'function' === typeof deps.now;
      // Closes the offer of an earlier first session call: did the agent do the offered step?
      if (agentCall) {
        noteNextCall(tool.name, args);
      }
      const ends = endsRun(tool.name, args);
      // A call that only ends a run starts none: a second yield in a row carries no empty report.
      if (agentCall && !ends && deps.attachId !== undefined) {
        runLedger.begin(deps.now(), deps.attachId);
      }
      // The project of the session a call ends, read while the session still exists: releasing a
      // tab removes it, and an unreadable project lost an unlinked user's cloud line.
      const endedIn =
        agentCall && ends ? safeRoot(() => sessionRoot(deps, sessionIdFromArgs(args))) : undefined;
      const raw = await loggedTool(tool, deps, args, call);
      const attach = currentDrivenBy() === undefined ? deps.attachId : undefined;
      const root =
        attach === undefined
          ? undefined
          : safeRoot(() => sessionRoot(deps, sessionIdFromArgs(args)));
      // The app notes before this call, so a note it learns counts as memory written.
      const notesBefore = agentCall && root !== undefined ? readAppNotes(root) : [];
      const answer = forTheAgent({
        name: tool.name,
        args,
        result: raw,
        attach,
        root,
        fold: NOTICE_FOLD,
      });
      if (!agentCall) {
        return answer;
      }
      runLedger.after(deps.now(), deps.attachId);
      noteToolResult(runLedger, tool.name, args, raw);
      const notesAfter = root === undefined ? [] : readAppNotes(root);
      runLedger.memoryWritten(notesAfter.filter((note) => !notesBefore.includes(note)).length);
      runLedger.memoryRead(notesBefore);
      if (!ends || null === answer || 'object' !== typeof answer) {
        return answer;
      }
      return {
        ...answer,
        ...runReportField(runLedger, endedIn ?? root, process.env, deps.now(), deps.attachId),
      };
    }),
  );
}

/** Advisories that become once-per-session notice lines. See agent/notices.ts. */
export const NOTICE_FOLD: NoticeFold = {
  advisories: [
    EnvelopeKey.FEEDBACK_PROMPT,
    EnvelopeKey.FEEDBACK_INVITE,
    EnvelopeKey.TALK_TO_US,
    EnvelopeKey.UPDATE_AVAILABLE,
    // NOT `version_skew`: it is decisive — it explains every result after it and names the command to
    // run — so it rides out as its own key, untouched (one-shot at its source already).
    EnvelopeKey.PLATFORM,
    EnvelopeKey.SESSION_LEASE,
    EnvelopeKey.SESSION_AGE_WARNING,
    EnvelopeKey.FEEDBACK_UNDELIVERED,
    EnvelopeKey.ZERO_INSTALL,
  ],
  notices: EnvelopeKey.NOTICES,
  next: EnvelopeKey.NEXT,
  warning: EnvelopeKey.WARNING,
  onceWarnings: new Map<string, string | undefined>([
    // `session.throttled` still rides on every result: only the paragraph explaining it goes.
    [THROTTLED_WARNING, undefined],
    [SKEW_VERDICT_WARNING, SKEW_SHORT_WARNING],
  ]),
};

async function loggedTool<Ext>(
  tool: ToolDef<Ext>,
  deps: ToolDeps<Ext>,
  args: Record<string, unknown>,
  call?: ToolCall,
): Promise<unknown> {
  const logPath = toolLogPath();
  const at = Date.now();
  // The tab this call drove, and where its events start: the call's effect on the page.
  const seen: DispatchSeen = {};
  const episode = (outcome: { result: unknown } | { error: string }): void => {
    // A record that cannot be built never fails the call it describes.
    safeRoot(() => {
      const from = seen.from;
      const effect =
        seen.session === undefined || from === undefined
          ? undefined
          : seen.session.eventsSince(from);
      const drivenBy = currentDrivenBy();
      const agent = agentNameOf(deps.attachId);
      const agentSession = agentSessionOf(deps.attachId);
      recordEpisodeCall(seen.session?.artifactRoot ?? deps.reticleRoot, deps.attachId, Date.now, {
        tool: tool.name,
        args,
        startedAt: at,
        endedAt: Date.now(),
        ...outcome,
        ...(seen.session === undefined ? {} : { sessionId: seen.session.id }),
        ...(agent === undefined ? {} : { agent }),
        ...(agentSession === undefined ? {} : { agentSession }),
        ...(drivenBy === undefined ? {} : { drivenBy }),
        ...(effect === undefined ? {} : { effect }),
      });
    });
  };
  try {
    const result = await dispatchTool(tool, deps, args, call, seen);
    if (logPath !== undefined) {
      logToolCall(logPath, { tool: tool.name, args, at, ms: Date.now() - at, result });
    }
    episode({ result });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (logPath !== undefined) {
      logToolCall(logPath, { tool: tool.name, args, at, ms: Date.now() - at, error: message });
    }
    episode({ error: message });
    throw error;
  }
}

/** What dispatch learned that the episode log needs: the tab it drove, and its clock at the start. */
interface DispatchSeen {
  session?: Session;
  from?: number | undefined;
}

async function dispatchTool<Ext>(
  tool: ToolDef<Ext>,
  deps: ToolDeps<Ext>,
  args: Record<string, unknown>,
  call?: ToolCall,
  seen: DispatchSeen = {},
): Promise<unknown> {
  // Both dispatch paths (MCP + programmatic) pass through here — the one place "which tool is mostly
  // used" can be counted. This used to EMIT an event per call; it now increments an in-process counter
  // that leaves once, with the session summary. A verification loop is 50–200 calls, and PostHog bills
  // per event — so the old design made the telemetry bill scale with how hard people used the product,
  // to answer a question the histogram answers better. Counting is also free: no network, no promise,
  // nothing to fail on a tool call's hot path.
  // Started/settled as a pair rather than a bare counter: several agents can be inside runTool at
  // once, so a single "last start" field would attribute one tool's duration to another. The returned
  // closure carries this call's own identity, which is also what makes peak-concurrency measurable.
  // A daemon that has served even one tool call is doing a job for somebody; see daemon-usefulness.
  noteToolCall();
  // The impact record needs the project's own `.reticle` root, and this is the first place every
  // call knows it. Idempotent: the first root wins for the daemon's lifetime.
  initImpact({ reticleRoot: deps.reticleRoot });
  // An oversized argument is refused BEFORE the handler deserialises it.
  //
  // tool-fuzz failed CI on the invariant that matters most — `every tool answers every hostile call`
  // — for a ~100KB string. Seen twice with different tools; the earlier one came back
  // `-32001 sse_aborted` with the tool surface dropping 48→17, which is a RESTARTED daemon. The
  // shape is: oversized argument → the daemon dies → the proxy answers the in-flight call with
  // transport loss, and the next assertion is talking to a different daemon.
  //
  // `TRANSPORT_LIMITS.MAX_STRING_LENGTH` already bounds what crosses the bridge; a tool argument
  // arrives over MCP stdio and never met it. Here, because this is the one place every invocation
  // routes through, so a tool added later inherits the bound instead of having to remember it.
  //
  // A refusal is a normal answer. An UNANSWERED call is a hung agent, and that is the failure this
  // prevents: the agent learns its argument was too big, which is something it can fix.
  const oversized = firstOversizedArg(args);
  if (oversized !== undefined) {
    const error =
      `argument '${oversized}' is larger than ${String(TRANSPORT_LIMITS.MAX_STRING_LENGTH)} ` +
      'characters, which is the most Reticle moves in one call. Nothing ran. Send a smaller ' +
      'value — a selector or an id rather than a document, or a slice of the text you need.';
    // Refused before the handler was ever entered, and still a refusal the agent has to recover
    // from. Reported here rather than at the return below, which this branch never reaches.
    reportRefusal(tool.name, args, error);
    return { error };
  }
  // One driver per tab. The Harness clicking through a page while the agent clicks too is two hands
  // on one mouse: neither result means anything. The agent's own action waits; its reads still run.
  const busy = ACTION_TOOLS.has(tool.name) ? harnessDriving(deps, args) : undefined;
  if (busy !== undefined) {
    const error = msgHarnessHasTheTab(busy);
    reportRefusal(tool.name, args, error);
    return { error };
  }
  // An ACTION is what gets abandoned. Counted here, against verifications, so "the agent drove the
  // page and then wandered off" becomes a number instead of an impression.
  if (ACTION_TOOLS.has(tool.name)) {
    getSessionMetrics().recordAction();
  }
  const settleTiming = getSessionMetrics().startToolCall(tool.name, args);
  const startedAt = Date.now();
  const rawSessionId = sessionIdFromArgs(args);
  const bound = SESSION_BOUND_TOOLS.has(tool.name);

  // Resolve the session identity ONCE, up front, for a live-session tool. The lease heartbeat must
  // target the session the handler will ACTUALLY drive — which, when the agent omits sessionId, is the
  // auto-selected one, NOT the raw (undefined) arg. Touching the raw arg meant an auto-selected drive
  // never refreshed its pool lease, so the reaper could reclaim the session mid-operation. Resolve
  // before the handler so a long ACT_AND_WAIT is protected for its whole duration; on failure leave it
  // to the handler to throw the canonical no-session error.
  let session: Session | undefined;
  if (bound || CDP_TOOLS.has(tool.name)) {
    try {
      session = deps.sessions.resolve(rawSessionId);
    } catch {
      session = undefined;
    }
  }
  // Nothing connected, and the app was never wired: a call that needs a page opens it zero-install
  // rather than answering with a diagnosis the agent stops at. See zero-install-first-call.ts.
  const openUnwired = deps.openUnwiredApp;
  const opened =
    openUnwired !== undefined &&
    session === undefined &&
    bound &&
    rawSessionId === undefined &&
    0 === deps.sessions.list().length
      ? await openUnwired()
      : undefined;
  if (opened !== undefined) {
    try {
      session = deps.sessions.resolve(rawSessionId);
    } catch {
      session = undefined;
    }
  }
  // CDP tools against a skewed session: refuse with the sentence reticle_sessions already knows,
  // before Playwright invents a closed page. ready:true leases still hit this path.
  if (session?.versionSkew !== undefined && CDP_TOOLS.has(tool.name)) {
    const message = session.versionSkew;
    reportRefusal(tool.name, args, message);
    throw new Error(message);
  }
  // A ref that was handed out by a DIFFERENT tab, on a call that named no session. Refused here, at
  // the one point that knows both the ref and the tab resolution picked — the handler only learns
  // that the ref missed, and answers that with "the DOM re-rendered", which is a confident diagnosis
  // of the wrong thing. The other half is worse: the same ref can resolve to a different element in
  // the guessed tab and return a green about a page nobody asked about.
  if (session !== undefined) {
    const wrongTab = wrongTabRefusal({
      ref: spentRefFromArgs(args),
      explicitSessionId: rawSessionId,
      chosenSessionId: session.id,
      connected: () => deps.sessions.list(),
    });
    if (wrongTab !== undefined) {
      // Refused before the handler was entered, so it is reported here — the same shape as the
      // oversized-argument refusal above.
      reportRefusal(tool.name, args, wrongTab);
      return { error: wrongTab };
    }
  }
  const leaseId = session?.id ?? rawSessionId;
  if (leaseId !== undefined) {
    deps.pool?.touch(leaseId);
  }
  // One identity for the whole call: the handler drives the session everything above is attributed
  // to, rather than resolving again against a registry that can have changed underneath it.
  const dispatchArgs = pinnedArgs(args, rawSessionId, session);
  if (session !== undefined) {
    seen.session = session;
    seen.from = safeRoot(() => session?.elapsed());
  }

  let raw: unknown;
  try {
    // The one dispatch point every tool call passes through, so it is where the trace's root span
    // belongs: with RETICLE_TRACE on, every stage that runs underneath inherits this call's id and
    // nests under it. Free when off — see trace.ts.
    // `dispatchArgs`, not `args`: an inferred session is pinned into the arguments before the
    // handler sees them, so a tool that resolves the session a second time cannot land on a
    // different one than the dispatcher chose.
    const invokeHandler = (): Promise<unknown> =>
      span('tool.handler', { tool: tool.name, session: session?.id }, () =>
        tool.handler(deps, dispatchArgs, call),
      );
    // The Harness's own inner calls carry their drive in an async context (`runDrivenBy`), which is
    // what attributes their verdicts; the outer explore call adjudicates nothing of its own.
    // As the agent on this connection, so a note it reads is marked seen by that agent.
    raw = await runAsAgent(deps.attachId, invokeHandler);
  } catch (error) {
    // The commonest refusal shape by far, and the one nothing could see: the message is built, handed
    // to the agent by the MCP boundary, and discarded. Reported here rather than at that boundary
    // because there are two of them (mcp.ts and the reticle_run hatch) and this is the one place both
    // go through — a third would otherwise be invisible from the day it was added.
    //
    // Under version skew, Playwright's "Target page has been closed" is the wrong cause (#688): the
    // page is still dialled in. Prefer the session's skew sentence when we already know the pair is
    // mismatched — including for tools that are not in CDP_TOOLS (real-input fallbacks that throw).
    let skewText = session?.versionSkew;
    if (skewText === undefined) {
      try {
        skewText = deps.sessions.resolve(rawSessionId).versionSkew;
      } catch {
        skewText = undefined;
      }
    }
    const rewritten = rewriteClosedAsSkew(error, skewText);
    const toThrow = rewritten ?? error;
    const message = toThrow instanceof Error ? toThrow.message : String(toThrow);
    reportRefusal(tool.name, args, message, toThrow);
    // The invitation on THIS path is the one `buildErrorPayload` attaches when it does not recognise
    // the error, and it was never counted — so the denominator excluded the commonest friction there
    // is. Gated on the payload actually carrying the ask, because a recognised error gets a recovery
    // instead and counting an invitation nobody was shown breaks the ratio in the other direction.
    const payload = buildErrorPayload(message, codedRefusalOf(toThrow));
    if (tool.name !== ReticleTool.RUN && payload.feedback !== undefined) {
      getSessionMetrics().recordFeedbackPrompt();
    }
    throw toThrow;
  } finally {
    // In a `finally` so a THROWN call still settles: otherwise every failing tool would leak a
    // concurrency slot and peakConcurrentTools would climb forever on an unhealthy session.
    settleTiming(Date.now() - startedAt);
  }
  raw = await withStepShot(tool.name, deps, args, raw, session?.id ?? rawSessionId);
  // Milestones describe work that ran. Refusals and paused calls must not consume the firsts.
  // Record action before verdict: act_and_wait can complete both in this same call.
  if (isPlainObject(raw) && !resultIsError(raw) && raw['paused'] !== true && raw['ok'] !== false) {
    noteOnboardingFirst(tool.name);
    const effect = raw['effect'];
    const acted =
      raw['dispatched'] !== false &&
      (!isPlainObject(effect) || effect['dispatched'] !== false) &&
      (tool.name !== ReticleTool.ACT_AND_WAIT || isPlainObject(effect));
    if (ACTION_TOOLS.has(tool.name) && acted) {
      noteActed(args);
    }
  }
  // The human-feedback ask rides out on the first VERIFICATION that completes — the one moment the
  // experience is fresh and there is something concrete to react to. It is spliced BEFORE the
  // session-bound early return, because two of the four verification tools (flow_verify,
  // verify_change) are session-EXEMPT and would otherwise never carry it.
  let verdict = false;
  if (isPlainObject(raw)) {
    // The brand comes from the session's own PAGE_HEALTH report, so it is present for the four
    // session-bound verification tools and absent for flow_verify (session-exempt) — which replays
    // into a browser Reticle launched, where `browser` already says what happened.
    verdict = recordVerification(
      tool.name,
      raw,
      Date.now() - startedAt,
      session?.brand,
      session?.id,
      session?.sdkVersion,
    );
    reportBugsFound(tool.name, raw, session?.id);
  }
  // The other half of the refusal surface. A top-level `error` string IS this codebase's refusal
  // convention, so half the tools refuse by RETURNING one rather than throwing — and reading only the
  // throw path would have measured half the wall and called it the whole of it, the same way `isError`
  // once did. A call that was served clears the retry chain, so the next refusal after it is a first
  // refusal rather than a retry of something unrelated.
  // The user's own record of what Reticle did for them. Same chokepoint as everything else that
  // counts, for the same reason: a second recording site is a second thing to forget. Separate
  // store from telemetry - this one never leaves the machine.
  const finishedAt = Date.now();
  const defect = defectForToolResult(raw, finishedAt);
  // Which project's ledger this call belongs to. Resolved from the SESSION being driven, not from
  // wherever the daemon happens to stand: one daemon serves many projects, and recording every
  // call against its own cwd is how one app's verdicts ended up on another account's dashboard.
  // Falls back to the daemon root when no session can be named, which is the old behaviour.
  const artifactRoot = session?.artifactRoot ?? deps.reticleRoot;
  recordImpact(
    deltaForToolResult(raw, finishedAt - startedAt, resultIsError(raw)),
    { ...(defect === undefined ? {} : { defect }) },
    artifactRoot,
  );
  // ...and the tab being driven is told, so the report is live rather than a thing you reload.
  // Optional-call, not optional-chain-on-the-object: a test double is a partial Session, and a
  // courtesy push must never be the reason a tool call throws.
  // Bound to THIS session's root: a tab must be shown its own project's numbers, not whichever
  // project the daemon was started in.
  session?.pushImpact?.(() => impactSnapshot(artifactRoot));
  if (resultIsError(raw)) {
    reportRefusal(tool.name, args, (raw as { error: string }).error);
  } else {
    noteToolServed();
    // Which tab these refs belong to. Recorded on the way OUT, so the next call that spends one is
    // measured against the tab that actually produced it.
    if (session !== undefined && REF_MINTING_TOOLS.has(tool.name)) {
      noteRefsMinted(session.id);
    }
  }
  // The feedback family is asked at most once per agent session (agent/notices.ts): gated here, at
  // the take, so a suppressed ask is never counted as one that was made.
  const asked = feedbackAlreadyAsked(currentDrivenBy() === undefined ? deps.attachId : undefined);
  // Only a call that produced a verdict asks: `reticle_act` is a verdict tool for its `steps` form.
  const prompt = verdict && !asked ? takeFeedbackPrompt(tool.name) : undefined;
  // Same one-shot channel as the feedback ask: the agent is mid-task, so anything it would have to go
  // and ASK for is something it will never ask for. Spliced on ANY tool result, not just a
  // verification, because an out-of-date install is worth mentioning whatever the agent is doing.
  const update = isPlainObject(raw) ? takeUpdateNudge() : undefined;
  // Same one-shot channel, for the same reason. Skew was only ever reported in
  // reticle_sessions.versionSkew and a CLI log line — two places an agent driving a flow never
  // looks — so it could work a whole session against a mismatched pair and never learn the one fact
  // that explains the behaviour. It rides out here on whatever tool it happens to be calling.
  const skew = isPlainObject(raw) ? takeVersionSkew(deps.peerSkew) : undefined;
  // A feedback report that was accepted and then failed to send. Same one-shot channel, because the
  // reporter is the only person who can act on it and they are not reading the daemon log — and a
  // report announced as accepted and then silently lost is the failure the awaited send existed to
  // prevent. See feedback-delivery.ts.
  const undelivered = isPlainObject(raw) ? takeFeedbackUndelivered() : undefined;
  // Invite feedback at the moment of friction, worded for what just happened. Counted, because
  // `feedback_submitted / feedbackPrompted` is the only thing that says whether the invitation works
  // at all rather than being decoration.
  //
  // This used to sit below the session-bound early return, which put it behind two conditions that
  // exclude most friction there is. A session-EXEMPT tool never reached it, and neither did a tool
  // that THREW — and throwing is the commonest refusal shape by a wide margin, i.e. exactly the
  // `refused` friction the line is written for. `errored` could only ever see the handlers that
  // RETURN an error. So the denominator was counting a small, unrepresentative slice of the
  // invitations and reading near-empty, which looks identical to a nudge that never fires.
  const friction = asked || prompt !== undefined ? undefined : frictionInviteFor(tool.name, raw);
  if (prompt !== undefined || friction !== undefined) {
    noteFeedbackAsked(currentDrivenBy() === undefined ? deps.attachId : undefined);
  }
  // Once per project, on a proved verdict, when the runs live only on this machine. Not on a result
  // whose `reticleResult` already ends with the platform line: once per result, never twice.
  const platform =
    isPlainObject(raw) && !(RESULT_FIELD in raw)
      ? await takePlatformMoment(deps, raw, () => sessionRoot(deps, rawSessionId))
      : undefined;
  // What the agent should do next, on every client that reads results. Not for the Harness, whose
  // runs the daemon syncs itself and which cannot relay the user's words, and not on `reticle_run`'s
  // outer result: the inner call already carried one.
  const next =
    isPlainObject(raw) && ReticleTool.RUN !== tool.name && currentDrivenBy() === undefined
      ? nextStep({
          tool: tool.name,
          unmatched: unmatchedRootOf(deps, rawSessionId),
          verdict: 'verified' in raw,
          root: safeRoot(() => sessionRoot(deps, rawSessionId)),
          // A partial deps (tests, the demo) may carry no clock; the line is advice, never a reason to fail.
          now: 'function' === typeof deps.now ? deps.now() : Date.now(),
        })
      : undefined;
  // Only an agent's own call (an MCP connection, not the Harness, not the HUD's or the chat's calls
  // into the same tools) takes what is waiting for the agent: those calls answer nobody who reads.
  const answer = isPlainObject(raw) ? raw : undefined;
  const agentCall =
    answer !== undefined && deps.attachId !== undefined && currentDrivenBy() === undefined;
  // A Harness drive started or finished, from the HUD, the platform's chat or this agent: one line,
  // once. Not about the run this very result already reports.
  // One-time advisories toward the platform and the Harness (`platform-moment.ts`), only on the agent's
  // own calls, riding the same platform line as the moments above.
  const nudge =
    agentCall && answer !== undefined
      ? await agentNudge({
          deps,
          tool: tool.name,
          raw: answer,
          isError: resultIsError(answer),
          root: safeRoot(() => sessionRoot(deps, rawSessionId)),
          harnessOn: () => impactSnapshot(artifactRoot)?.harnessConfig?.harnessEnabled,
        })
      : undefined;
  const platformLine =
    platform === undefined ? nudge : nudge === undefined ? platform : `${platform}\n${nudge}`;
  const drives = agentCall
    ? takeDriveNotes('string' === typeof answer?.['runId'] ? answer['runId'] : undefined)
    : [];
  // The person's notes from the HUD, on ANY tool. Act tools splice their own `control` first.
  const notes =
    agentCall && answer !== undefined && !(EnvelopeKey.CONTROL in answer)
      ? await runAsAgent(deps.attachId, () =>
          Promise.resolve(takeHumanNotes(deps.sessions, rawSessionId, session)),
        )
      : undefined;
  const result =
    0 === drives.length &&
    notes === undefined &&
    prompt === undefined &&
    update === undefined &&
    skew === undefined &&
    undelivered === undefined &&
    friction === undefined &&
    platformLine === undefined &&
    next === undefined
      ? raw
      : {
          // First, so a model that truncates a long result still reads it.
          ...(next !== undefined ? { [EnvelopeKey.NEXT]: next } : {}),
          ...(raw as object),
          ...(friction !== undefined
            ? {
                [EnvelopeKey.FEEDBACK_INVITE]: inviteFor(friction),
                // The founder's calendar only for an agent genuinely STUCK (the same call, again,
                // with no progress). An ordinary refusal carried it too, and read as a sales pitch
                // stapled to an error message.
                ...(FrictionKind.REPEATING === friction
                  ? { [EnvelopeKey.TALK_TO_US]: DiscoveryInvite.AGENT }
                  : {}),
              }
            : {}),
          ...(prompt !== undefined ? { [EnvelopeKey.FEEDBACK_PROMPT]: prompt } : {}),
          ...(update !== undefined ? { [EnvelopeKey.UPDATE_AVAILABLE]: update } : {}),
          ...(skew !== undefined ? { [EnvelopeKey.VERSION_SKEW]: skew } : {}),
          ...(platformLine !== undefined ? { [EnvelopeKey.PLATFORM]: platformLine } : {}),
          ...(0 === drives.length ? {} : { [EnvelopeKey.HARNESS]: drives.join('\n') }),
          ...(notes === undefined ? {} : { [EnvelopeKey.CONTROL]: notes }),
          ...(undelivered !== undefined
            ? {
                [EnvelopeKey.FEEDBACK_UNDELIVERED]: `your earlier report did NOT send: ${undelivered}. Tell the human what you found so it is not lost.`,
              }
            : {}),
        };
  if (!bound || !isPlainObject(result)) {
    return result;
  }
  // Reuse the session resolved above so the health envelope describes the SAME session the handler
  // drove; only re-resolve if the up-front attempt failed but the handler somehow succeeded.
  // A handler that answered with no tab to resolve (a Harness drive polled by runId after a daemon
  // restart reads its record from disk) keeps its answer: there is no session health to describe.
  let driven = session;
  try {
    driven ??= deps.sessions.resolve(rawSessionId);
  } catch {
    return result;
  }
  // ...unless the call replaced that document. A full navigation or reload registers a NEW Session
  // under the same id (or under the id the result reports it arrived at), and the object resolved
  // before the call is the page that unloaded: it reported itself hidden on the way out, so every
  // response after a navigation said "throttled" about a tab that was fine. Describe what is there
  // now. Optional-called because a test double is a partial SessionManager.
  const arrivedId = 'string' === typeof result['sessionId'] ? result['sessionId'] : driven.id;
  const resolved = deps.sessions.get?.(arrivedId) ?? driven;
  const envelope: Record<string, unknown> = {};
  // A leased tab opened with `initScript` runs a STUB of the bindings a desktop shell injects. Said
  // on every session-bound result, not only on verdicts, for the same reason health is: a green from
  // that tab proves the app's view logic, and nothing else in the result would say so.
  // Optional-called: a partial pool in a test double has no lookup, and absence must read as "no
  // stub", never as a crash on the whole tool surface.
  if (true === deps.pool?.stubInstalled?.(resolved.id)) {
    envelope[EnvelopeKey.HOST_STUB] = HOST_STUB_NOTE;
  }
  const behind = sdkBehindNote(resolved);
  if (behind !== undefined && 'verified' in result) {
    envelope[EnvelopeKey.SDK_BEHIND] = behind;
  }
  // The health block is idempotent: add it only when the handler didn't already include a `session`.
  if (!('session' in result)) {
    Object.assign(envelope, healthEnvelope(resolved));
  }
  // Lease + age-warning are INDEPENDENT of the health block. Previously the `'session' in result`
  // early-return skipped them whenever a handler returned its own health (which a throttled tab always
  // does) — so a long-running backgrounded session, the case most likely to leak, never got the
  // one-time pool-lease reminder or the age cleanup nudge. Splice them regardless.
  const lease = resolved.takeSessionLease();
  // In CI there is no panel and no human to hand it back to: the reminder was noise in every
  // pipeline log. Still taken, so the once-per-session cadence is unchanged.
  if (lease !== undefined && process.env['CI'] === undefined) {
    envelope[EnvelopeKey.SESSION_LEASE] = lease;
  }
  if (opened !== undefined) {
    envelope[EnvelopeKey.ZERO_INSTALL] = opened.notice;
  }
  const warning = resolved.ageWarning();
  if (warning !== undefined) {
    envelope[EnvelopeKey.SESSION_AGE_WARNING] = warning;
  }
  // Ask for a verdict when the agent has driven the page and not asked for one: a session that never
  // calls a verdict-producing tool proves nothing, however many tools it used. One-shot per
  // abandoned run, same discipline as the pool lease — a hint on every call is noise that gets tuned
  // out.
  // The A/B control, and the reason it exists as an env flag rather than a code edit.
  //
  // `verify_next` is described in this repo's own changelog as "the largest known lever on whether a
  // session produces a verdict at all", and it has never been measured — it was once built, fired
  // and silently dropped by schema-strict clients for a whole release, which is exactly what an
  // unmeasured lever looks like from the inside. "The payload now arrives" and "the agent acts on
  // it" are different claims and only the first was ever verified.
  //
  // Suppressing it for a control arm has to leave the ONLY difference being the baton: same build,
  // same surface, same counters. So the nudge is still TAKEN (the counter still resets, so the
  // one-shot cadence is identical) and only the envelope key is withheld.
  const suppressBaton = '1' === process.env[SUPPRESS_VERIFY_NEXT_ENV];
  const unverified = getSessionMetrics().takeUnverifiedNudge();
  // Carry the CALL, not just the sentence. The prose has to be translated back into arguments, and
  // that translation is where agents were already going wrong — `until` omitted, action arguments
  // flat instead of nested under `args`. `ref` and `action` come from the act that actually
  // dispatched, so the suggestion is about the element the agent touched. See verify-next-baton.
  if (unverified !== undefined && !suppressBaton)
  // `lastAct` read defensively: this envelope is built on EVERY tool call, so a session shape
  // without it would turn a missing field into a crash on the whole surface rather than a missing
  // suggestion. The baton degrades to prose, which is what it carried before.
  {
    envelope[EnvelopeKey.VERIFY_NEXT] = verifyNextBaton(
      unverified,
      resolved.lastAct?.effect() ?? {},
    );
  }
  return Object.keys(envelope).length > 0 ? { ...result, ...envelope } : result;
}

/**
 * A picture of the page the moment this call's outcome was decided, named on the result. Only on
 * an answer that touched the page: a refusal or a paused call drove nothing worth a picture. A
 * navigation can land the page under a new id, so the id the result reports wins.
 */
async function withStepShot<Ext>(
  name: string,
  deps: ToolDeps<Ext>,
  args: Record<string, unknown>,
  raw: unknown,
  sessionId: string | undefined,
): Promise<unknown> {
  if (!STEP_SHOT_TOOLS.has(name) || Array.isArray(args['steps'])) {
    return raw;
  }
  if (!isPlainObject(raw) || resultIsError(raw) || true === raw['paused']) {
    return raw;
  }
  const tab = 'string' === typeof raw['sessionId'] ? raw['sessionId'] : sessionId;
  if (tab === undefined) {
    return raw;
  }
  // Paired with its check when the run is written: the n-th verdict picture is the n-th check.
  const verdict =
    'verified' in raw && (ReticleTool.ACT_AND_WAIT === name || ReticleTool.ASSERT === name);
  return { ...raw, [EnvelopeKey.SCREENSHOT]: await takeStepShot(deps, tab, name, { verdict }) };
}

/** A root, or undefined when none can be resolved: a missing root is never a reason to throw. */
function safeRoot<T>(get: () => T): T | undefined {
  try {
    return get();
  } catch {
    return undefined;
  }
}

/**
 * Where this session's evidence goes when no project claims it (`~/.reticle/unmatched/<id>`), with
 * the folders that compete for its id; undefined when it lands in a project. Never throws.
 */
function unmatchedRootOf(
  deps: ToolDeps,
  sessionId: string | undefined,
): { root: string; contenders: readonly string[]; serving?: string } | undefined {
  try {
    const target = sessionTarget(deps, sessionId);
    // A lease that claimed a root writes there. The page's unmatched bucket is not where this
    // run goes, so naming it would send the agent to fix a folder the run never touches.
    if (target.claimedRoot !== undefined) {
      return undefined;
    }
    const resolved = deps.artifactRootFor?.(target.projectId, target.origin);
    if (resolved === undefined || ArtifactRootReason.MATCHED_PROJECT === resolved.reason) {
      return undefined;
    }
    if (resolved.root === deps.reticleRoot) {
      return undefined;
    }
    return {
      root: resolved.root,
      contenders: resolved.candidates ?? [],
      ...(resolved.serving === undefined ? {} : { serving: resolved.serving }),
    };
  } catch {
    return undefined;
  }
}
