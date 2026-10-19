/**
 * The run ledger: what one agent run checked, saved and read, kept until its report is taken.
 *
 * A run is the agent's calls from its first Reticle call to the call that ends it (a session end, a
 * yield, a released tab). The verdicts come from the journal records the agent's own calls wrote;
 * the Harness's are never counted. Taking the report empties the ledger, so the next run starts at
 * zero.
 *
 * A call from another agent (another MCP attach id) starts a new run. An agent that stops without a
 * call that ends its run then does not leak its claims into the next agent's report.
 *
 * ponytail: one ledger for each daemon, not for each agent. Two agents that call at the same time
 * restart each other's run. Key the ledger by attach id when that happens.
 */
import { supersededChecks } from '@reticlehq/engine/evidence/superseded-checks.js';
import {
  JournalVerdictEffectSchema,
  ReticleTool,
  Verified,
  type JournalAction,
  type JournalVerdictEffect,
  type RunReport,
  type RunReportClaim,
} from '@reticlehq/core';

const SAW = 'saw ';
const FLOW = 'flow ';

/** One piece of evidence for a claim: what the check saw, else the source line it drove. */
function evidenceOf(effect: JournalVerdictEffect): string | undefined {
  if (effect.observed !== undefined) return `${SAW}${effect.observed}`;
  return effect.source;
}

/** `no` when anything failed, `yes` only when something held and nothing was undecided. */
function runVerified(all: readonly Verified[]): Verified {
  if (all.includes(Verified.NO)) return Verified.NO;
  if (0 === all.length || all.some((v) => Verified.YES !== v)) return Verified.UNKNOWN;
  return Verified.YES;
}

export class RunLedger {
  #owner: string | undefined;
  #startedAt: number | undefined;
  #firstVerdictAt: number | undefined;
  #verdicts: JournalVerdictEffect[] = [];
  #saved = new Set<string>();
  #replayed = new Map<string, Verified>();
  #written = 0;
  #read = new Set<string>();

  /** An agent call starts. The first one starts the run, and a call from another agent starts a new one. */
  begin(now: number, owner: string): void {
    if (this.#owner !== owner) this.#reset();
    this.#owner = owner;
    this.#startedAt ??= now;
  }

  /** An agent call ended. The first one that left a verdict sets the time to the first verdict. */
  after(now: number): void {
    if (0 < this.#verdicts.length || 0 < this.#replayed.size) this.#firstVerdictAt ??= now;
  }

  /** A journal record from the agent's own call. A record with no verdict is not a claim. */
  verdict(action: JournalAction): void {
    if (this.#idle() || action.drivenBy !== undefined) return;
    // A replay is counted once, as a flow, decided as its run decides it (`replayed`). Its journal
    // record said `unknown` where the run said `no`, and one report gave both answers.
    if (ReticleTool.FLOW_REPLAY === action.tool) return;
    const parsed = JournalVerdictEffectSchema.safeParse(action.effect);
    if (parsed.success) this.#verdicts.push(parsed.data);
  }

  flowSaved(name: string): void {
    if (!this.#idle()) this.#saved.add(name);
  }

  /** The last replay of a flow in this run is its verdict. */
  replayed(name: string, verified: Verified): void {
    if (!this.#idle()) this.#replayed.set(name, verified);
  }

  memoryWritten(count = 1): void {
    if (!this.#idle()) this.#written += count;
  }

  /** Notes given to the agent. Each one counts once, however often it is shown. */
  memoryRead(notes: readonly string[]): void {
    if (this.#idle()) return;
    for (const note of notes) this.#read.add(note);
  }

  isEmpty(): boolean {
    return this.#idle();
  }

  /**
   * No agent run is open. A CLI `reticle verify` replays through the same code, and what it did is
   * not the next agent's run, so nothing is kept until an agent call begins one.
   */
  #idle(): boolean {
    return this.#startedAt === undefined;
  }

  /** The report, without the cloud line (the caller knows the project). Empties the ledger. */
  take(now: number): RunReport {
    const started = this.#startedAt ?? now;
    // A passive check that read too early is not counted: the rule every fold applies.
    const superseded = supersededChecks(
      this.#verdicts.map((v) => ({
        key: v.claim,
        passive: false === v.declaredBeforeActing,
        held: Verified.YES === v.verified,
        failed: Verified.NO === v.verified,
      })),
    );
    const counted = this.#verdicts.filter((_, at) => !superseded.has(at));
    const claims = counted.map((v): RunReportClaim => {
      const evidence = evidenceOf(v);
      return evidence === undefined
        ? { claim: v.claim, verified: v.verified }
        : { claim: v.claim, verified: v.verified, evidence };
    });
    const replayed = [...this.#replayed].map(([name, verified]) => ({ name, verified }));
    const report: RunReport = {
      verified: runVerified([...claims.map((c) => c.verified), ...replayed.map((r) => r.verified)]),
      claims,
      caught: [
        ...claims.filter((c) => Verified.NO === c.verified).map((c) => c.claim),
        ...replayed.filter((r) => Verified.NO === r.verified).map((r) => `${FLOW}${r.name}`),
      ],
      flows: { saved: [...this.#saved], replayed },
      memory: { written: this.#written, read: this.#read.size },
      wallMs: Math.max(0, now - started),
      ...(this.#firstVerdictAt === undefined
        ? {}
        : { firstVerdictMs: Math.max(0, this.#firstVerdictAt - started) }),
    };
    this.#reset();
    return report;
  }

  #reset(): void {
    this.#owner = undefined;
    this.#startedAt = undefined;
    this.#firstVerdictAt = undefined;
    this.#verdicts = [];
    this.#saved = new Set();
    this.#replayed = new Map();
    this.#written = 0;
    this.#read = new Set();
  }
}

/** The daemon's ledger. */
export const runLedger = new RunLedger();
