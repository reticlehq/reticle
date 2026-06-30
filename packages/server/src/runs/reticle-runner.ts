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

import type { FlowReplayResult, ReticleVerificationRun, RunId } from '@reticle/protocol';
import { buildVerificationRun, type VerificationRunInput } from './build-verification-run.js';
import { mapReplayToFlowResult } from './replay-mapping.js';
import { buildRepairPackets } from './repair-prompt.js';
import {
  buildRisks,
  classifyChangedFiles,
  type ChangedFileInput,
  type RiskPolicy,
} from './risk-classify.js';

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
}

/** Run metadata the caller supplies; flows + verdict are produced by verify(). */
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
}

export class ReticleRunner {
  readonly #port: RunnerPort;

  constructor(port: RunnerPort) {
    this.#port = port;
  }

  /**
   * Replay the named flows (or every saved flow), map each outcome into the artifact, and assemble a
   * verdict. Sequential by design — flows share the one live app and parallel replay would race the
   * DOM (the same reason reticle_flow_verify is sequential).
   */
  async verify(opts: VerifyOptions): Promise<ReticleVerificationRun> {
    const names = opts.names ?? (await this.#port.listFlows());
    const replays = [];
    const flows = [];
    for (const name of names) {
      const start = this.#port.now();
      const replay = await this.#port.replayFlow(name);
      replays.push(replay);
      flows.push(mapReplayToFlowResult(replay, this.#port.now() - start));
    }

    const changedFiles = classifyChangedFiles(opts.changedFiles ?? []);
    const risks = buildRisks(changedFiles, opts.policy);
    const failurePackets = buildRepairPackets(replays);

    const input: VerificationRunInput = {
      runId: this.#port.newRunId(),
      durationMs: flows.reduce((sum, f) => sum + f.durationMs, 0),
      profile: opts.profile,
      project: opts.project,
      agent: opts.agent,
      trigger: opts.trigger,
      changedFiles,
      flows,
      checks: [],
      risks,
      evidence: { consoleErrors: [], networkAnomalies: [], stateAssertions: [], timeline: [] },
      ...(failurePackets.length > 0 ? { repair: { failurePackets } } : {}),
    };
    return buildVerificationRun(input, () => this.#port.now());
  }
}
