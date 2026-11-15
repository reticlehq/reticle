/**
 * ReticleRunner — the programmatic Replay/Verify API a host platform (OEM/design partner) or CI drives
 * from its own pipeline, with no MCP stdio and no human. It reuses the existing flow-replay machinery
 * and the verification-run assembler, returning a stable ReticleVerificationRun.
 *
 * Everything it needs from the live world is injected through RunnerPort, so the core orchestration is
 * fully testable without a CDP browser. The live adapter (wrapping ToolDeps: replayNamedFlow,
 * flows.list, the drive/CDP preview boot) and the token-guarded HTTP endpoint are thin layers built on
 * top of this — the orchestration and the verdict live here so the MCP path and the API produce the
 * same artifact byte-for-byte.
 */

import { reportRunTelemetry } from '@/telemetry/run-telemetry.js';
import {
  boundFlowName,
  RunFlowStatus,
  VerifyPhase,
  ReplayStatus,
  type FlowReplayResult,
  type ReticleVerificationRun,
  type RunId,
  type VerifyProgressEvent,
} from '@reticlehq/core';
import {
  buildVerificationRun,
  type VerificationRunInput,
} from './artifact/build-verification-run.js';
import { mapReplayToFlowResult } from './artifact/replay-mapping.js';
import { buildRepairPackets } from './repair-prompt.js';
import { withShotRun } from './default-run-id.js';
import {
  buildRisks,
  classifyChangedFiles,
  type ChangedFileInput,
  type RiskPolicy,
} from './risk-classify.js';

/*
 * What a run says about a flow whose browser session dropped and did not come back (#2060).
 *
 * A flow that goes to a page without the Reticle SDK (a server's error page, a page outside the app)
 * ends the session. The generic no-session message then sent the reader to check the port and the
 * SDK setup, which worked a moment before. These reasons say first what the run saw: the session was
 * connected, it dropped after the page went to a URL, and no session came back.
 */

/** The words that identify this cause in a reason. A reader and a test can search for them. */
export const NO_SESSION_AFTER_NAVIGATION = 'no session after navigation';

/** Where the session was lost, as the browser saw it. Absent when the browser cannot say. */
export interface SessionLoss {
  lastUrl?: string;
}

function whereLost(loss: SessionLoss): string {
  return loss.lastUrl === undefined
    ? 'after a navigation'
    : `after the page went to ${loss.lastUrl}`;
}

/** What to change. With no URL, the reason cannot point at one page. */
function whatToChange(loss: SessionLoss): string {
  return loss.lastUrl === undefined
    ? 'Make sure that each page that the flow goes to loads @reticlehq/browser, or end the flow ' +
        'before it leaves the app.'
    : 'Make sure that the page at that URL loads @reticlehq/browser, or end the flow before it ' +
        'leaves the app.';
}

/** The reason for the flow during which the session dropped and did not come back. */
export function sessionLostReason(loss: SessionLoss): string {
  return (
    `${NO_SESSION_AFTER_NAVIGATION}: the session was connected, then it dropped ` +
    `${whereLost(loss)}, and no session connected again. The port and the SDK setup worked ` +
    `before this flow. ${whatToChange(loss)}`
  );
}

/** The flow in which the session was lost, and if the start URL was opened again after it. */
export interface LostSession {
  flow: string;
  loss: SessionLoss;
  reopened: boolean;
}

/** Why the app did not come back: the session dropped in a flow, and no session came back. */
function stayedLost({ flow, loss, reopened }: LostSession): string {
  const after = reopened
    ? 'opening the start URL again did not bring a session back'
    : 'no session came back';
  return (
    `${NO_SESSION_AFTER_NAVIGATION}: the session dropped in flow "${flow}" ` +
    `${whereLost(loss)}, and ${after}.`
  );
}

/** The reason for a later flow, when no session came back after the session was lost. */
export function notRunAfterLossReason(lost: LostSession): string {
  return `not run, ${stayedLost(lost)} Nothing was proved for this flow.`;
}

/** The words before the reason that a flow's replay gave, when a session-loss reason comes first. */
export const REPLAY_REASON_LEAD = 'The replay of this flow said:';

/** `lead`, then the reason the replay gave when it gave one. Rule 11: the replay's reason stays. */
function keepReplayReason(lead: string, own: string | undefined): string {
  return own === undefined ? lead : `${lead} ${REPLAY_REASON_LEAD} ${own}`;
}

/**
 * The reason for the flow that tried once after the session was lost, and got no session. It
 * starts with what the run saw, and keeps the reason the replay gave.
 */
export function triedAfterLossReason(lost: LostSession, own?: string): string {
  return keepReplayReason(stayedLost(lost), own);
}

/** The live capabilities ReticleRunner needs. Injected so tests pass fakes (no CDP, no session). */
export interface RunnerPort {
  /** Saved flow names to verify when the caller doesn't pass an explicit subset. */
  listFlows(): Promise<string[]>;
  /** Replay one saved flow against the live/preview app, returning the existing replay contract. */
  replayFlow(name: string): Promise<FlowReplayResult>;
  /** Injected clock — the single time source (no Date.now in logic, rule 7). */
  now(): number;
  /** Injected run-id generator (no Math.random in logic) — the live adapter supplies a branded uuid. */
  newRunId(): RunId;
  /**
   * Called once when a run starts. The live port forgets the tab that the last run drove: one port
   * serves every run of `reticle serve --http`. Optional.
   */
  startRun?(): void;
  /**
   * Asked after each flow: is the session of the run's tab gone, and did it stay gone? Undefined
   * when it is connected. Optional: a port without it behaves as before.
   */
  sessionLost?(): Promise<SessionLoss | undefined>;
  /**
   * Asked with no wait before each later flow, after the session was lost and one flow tried and
   * got none: can the run's tab have a session again? False skips the flow. Optional: a port
   * without it skips each later flow.
   */
  sessionBack?(): Promise<boolean>;
  /**
   * Open the run's start URL again in the tab that lost its session. True when the page loaded.
   * It does not wait for a session: the next flow's replay waits for its start page, as every
   * replay does. That wait also covers a slow dev server (#2155).
   */
  reopen?(): Promise<boolean>;
}

/**
 * Narration for a run in flight. Optional, and never load-bearing.
 *
 * A verification is silent for its whole duration, so anything watching from outside cannot tell a
 * run that is working from one that has died. This is the seam that makes the difference visible.
 * It reports what is HAPPENING; the artifact remains the only record of what was PROVED.
 */
export type VerifyProgressListener = (event: VerifyProgressEvent) => void;

/** Run metadata the caller supplies; flows + verdict are produced by verify. */
export interface VerifyOptions {
  names?: string[];
  project: VerificationRunInput['project'];
  agent: VerificationRunInput['agent'];
  trigger: VerificationRunInput['trigger'];
  profile: VerificationRunInput['profile'];
  /** The change set under test — classified into risk surfaces (auth/payment/db/…). */
  changedFiles?: ChangedFileInput[];
  /** Which touched surfaces block the verdict (require human confirmation). */
  policy?: RiskPolicy;
  /**
   * Called as each flow starts and finishes. Best-effort by contract: a listener that throws is
   * swallowed, because a REPORTER must never be able to fail the thing it is reporting on.
   */
  onProgress?: VerifyProgressListener;
}

/**
 * A flow whose replay threw (its browser session was lost, the app stopped answering) proves
 * nothing, and it must not take the other flows of the suite down with it. It is graded as a replay
 * that could not be completed: skipped, never a pass, with the error as the reason.
 */
function replayThatCouldNotRun(name: string, error: unknown): FlowReplayResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    name,
    status: ReplayStatus.UNVERIFIABLE,
    steps: [],
    unverifiable: { reason: `the replay stopped before it could be graded: ${message}` },
  };
}
/**
 * A flow that was not proved, with `lead` before the reason its replay gave. The replay's reason is
 * kept (rule 11): the session loss is added to it, not put in its place. A pass or a failure keeps
 * its own verdict: it was graded before the session dropped.
 */
function withLossReason(
  replay: FlowReplayResult,
  lead: (own?: string) => string,
): FlowReplayResult {
  if (replay.status !== ReplayStatus.UNVERIFIABLE && replay.unverifiable === undefined) {
    return replay;
  }
  return {
    ...replay,
    status: ReplayStatus.UNVERIFIABLE,
    unverifiable: { reason: lead(replay.unverifiable?.reason) },
  };
}

/** The reason of a flow during which the session was lost, with the replay's own reason after it. */
function sessionLostWith(loss: SessionLoss): (own?: string) => string {
  return (own) => keepReplayReason(sessionLostReason(loss), own);
}

/** A flow that was not replayed, because the session was lost in an earlier flow and stayed lost. */
function notRunAfterLoss(name: string, lost: LostSession): FlowReplayResult {
  return {
    name,
    status: ReplayStatus.UNVERIFIABLE,
    steps: [],
    unverifiable: { reason: notRunAfterLossReason(lost) },
  };
}

export class ReticleRunner {
  readonly #port: RunnerPort;

  constructor(port: RunnerPort) {
    this.#port = port;
  }

  /**
   * Replay one flow, then look at the session. A flow that leaves the app on a page with no SDK
   * ends the session. That flow's reason names the URL, and the app is opened again. The next flow
   * then tries once, and its replay waits for its start page as every replay does (#2155). When
   * that flow also ends with no session and ran no step, the app did not come back: `gone` is set.
   * Each later flow then asks the port, with no wait, if the session can be back. If it cannot,
   * the flow is not replayed: with no session, a replay only waits (#2060).
   *
   * `retrying` is the loss that the app was opened again for, before this flow.
   */
  async #replayOne(
    runId: RunId,
    name: string,
    more: boolean,
    retrying: LostSession | undefined,
  ): Promise<{ replay: FlowReplayResult; lost?: LostSession; gone?: LostSession }> {
    const replay = await withShotRun(runId, () => this.#port.replayFlow(name)).catch(
      (error: unknown) => replayThatCouldNotRun(name, error),
    );
    const loss = await this.#port.sessionLost?.().catch(() => undefined);
    if (loss === undefined) {
      return { replay };
    }
    if (retrying !== undefined && 0 === replay.steps.length) {
      const tried = withLossReason(replay, (own) => triedAfterLossReason(retrying, own));
      return { replay: tried, gone: retrying };
    }
    const lost = withLossReason(replay, sessionLostWith(loss));
    if (!more) {
      return { replay: lost };
    }
    const reopened = await (this.#port.reopen?.() ?? Promise.resolve(false)).catch(() => false);
    return { replay: lost, lost: { flow: name, loss, reopened } };
  }

  /** Before a later flow, once the session stayed lost: can it be back? No wait (#2060). */
  async #sessionBack(): Promise<boolean> {
    return (await this.#port.sessionBack?.().catch(() => false)) ?? false;
  }

  /**
   * Replay the named flows (or every saved flow), map each outcome into the artifact, and assemble a
   * verdict. Sequential by design — flows share the one live app and parallel replay would race the
   * DOM (the same reason reticle_flow_verify is sequential).
   */
  async verify(opts: VerifyOptions): Promise<ReticleVerificationRun> {
    this.#port.startRun?.();
    const names = opts.names ?? (await this.#port.listFlows());
    /*
     * Emitting NEVER throws into the run. A dashboard, a log or an editor is watching, and none of
     * them is worth failing a verification for — so a listener that blows up is dropped here rather
     * than unwinding a suite somebody is waiting on.
     */
    const emit = (event: VerifyProgressEvent): void => {
      try {
        opts.onProgress?.(event);
      } catch {
        /* a reporter cannot fail the thing it reports on */
      }
    };
    const total = names.length;
    // Announced BEFORE the loop: "step 3" without "of 12" does not answer the only question a
    // person watching is actually asking, which is whether to keep waiting.
    emit({ phase: VerifyPhase.FLOWS_FOUND, total, at: this.#port.now() });

    // Minted first, so each replayed step's screenshot is filed under the run it belongs to.
    const runId = this.#port.newRunId();
    let retrying: LostSession | undefined;
    let gone: LostSession | undefined;
    const replays = [];
    const flows = [];
    for (const [index, name] of names.entries()) {
      const start = this.#port.now();
      emit({
        phase: VerifyPhase.FLOW_STARTED,
        index,
        total,
        name: boundFlowName(name),
        at: start,
      });
      let replay: FlowReplayResult;
      if (gone !== undefined && !(await this.#sessionBack())) {
        replay = notRunAfterLoss(name, gone);
      } else {
        const outcome = await this.#replayOne(runId, name, index < total - 1, retrying);
        replay = outcome.replay;
        retrying = outcome.lost;
        gone = outcome.gone;
      }
      replays.push(replay);
      const mapped = mapReplayToFlowResult(replay, this.#port.now() - start);
      flows.push(mapped);
      emit({
        phase: VerifyPhase.FLOW_FINISHED,
        index,
        total,
        name: boundFlowName(name),
        // A convenience for colouring a row while the run is live. The VERDICT is computed from the
        // graded artifact below and never from this.
        ok: mapped.status === RunFlowStatus.PASS,
        at: this.#port.now(),
      });
    }
    emit({ phase: VerifyPhase.GRADING, total, at: this.#port.now() });

    const changedFiles = classifyChangedFiles(opts.changedFiles ?? []);
    const risks = buildRisks(changedFiles, opts.policy);
    const failurePackets = buildRepairPackets(replays);

    const input: VerificationRunInput = {
      runId,
      durationMs: flows.reduce((sum, f) => sum + f.durationMs, 0),
      profile: opts.profile,
      project: opts.project,
      agent: opts.agent,
      trigger: opts.trigger,
      changedFiles,
      flows,
      checks: [],
      risks,
      // What the replay windows saw. An empty list written here regardless read as a clean
      // console on a run whose steps had counted errors (#1344).
      evidence: {
        consoleErrors: replays.flatMap((r) => r.steps.flatMap((step) => step.consoleErrors ?? [])),
        networkAnomalies: [],
        stateAssertions: [],
        timeline: [],
      },
      ...(failurePackets.length > 0 ? { repair: { failurePackets } } : {}),
    };
    const run = buildVerificationRun(input, () => this.#port.now());
    reportRunTelemetry(run);
    return run;
  }
}
