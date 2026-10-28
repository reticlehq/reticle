/**
 * The run ledger: what each agent run checked, saved and read, kept until its report is taken.
 *
 * A run is one agent's calls from its first Reticle call to the call that ends it (a session end, a
 * yield, a released tab). The verdicts come from the journal records the agent's own calls wrote;
 * the Harness's are never counted. Taking the report ends that run, so the agent's next run starts
 * at zero.
 *
 * The ledger keeps one run for each MCP attach id. Two agents on one daemon (two worktrees of one
 * project) call in turn. When the ledger kept one run, each call restarted the other agent's run,
 * and a released lease reported the other agent's claims and none of its own. A record goes to the
 * run of the connection that wrote it, and a call that ends a run takes the caller's run (#1900).
 *
 * A record from no connection (the HUD, the CLI, an agent record that ends outside its call
 * context) goes to the run of the agent that called last. An agent that stops without a call that
 * ends its run leaves its run here. That run is dropped when it is idle for `RUN_IDLE_LIMIT_MS`.
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
import { callingAttachId } from '@/hooks/coding-agents.js';

const SAW = 'saw ';
const FLOW = 'flow ';

/** A run with no agent call for this long is dropped. A working agent calls much more often. */
export const RUN_IDLE_LIMIT_MS = 6 * 60 * 60 * 1000;

/** One piece of evidence for a claim: what the check saw, else the source line it drove. */
function evidenceOf(effect: JournalVerdictEffect): string | undefined {
  if (effect.observed !== undefined) {
    return `${SAW}${effect.observed}`;
  }
  return effect.source;
}

/** `no` when anything failed, `yes` only when something held and nothing was undecided. */
function runVerified(all: readonly Verified[]): Verified {
  if (all.includes(Verified.NO)) {
    return Verified.NO;
  }
  if (0 === all.length || all.some((v) => Verified.YES !== v)) {
    return Verified.UNKNOWN;
  }
  return Verified.YES;
}

/** One agent's open run. */
interface Run {
  startedAt: number;
  lastAt: number;
  firstVerdictAt: number | undefined;
  verdicts: JournalVerdictEffect[];
  saved: Set<string>;
  replayed: Map<string, Verified>;
  written: number;
  read: Set<string>;
}

const openRun = (now: number): Run => ({
  startedAt: now,
  lastAt: now,
  firstVerdictAt: undefined,
  verdicts: [],
  saved: new Set(),
  replayed: new Map(),
  written: 0,
  read: new Set(),
});

export class RunLedger {
  readonly #runs = new Map<string, Run>();
  #last: string | undefined;

  /** An agent call starts. The agent's first call starts its run. A run idle too long is dropped. */
  begin(now: number, owner: string): void {
    for (const [id, run] of this.#runs) {
      if (now - run.lastAt > RUN_IDLE_LIMIT_MS) {
        this.#runs.delete(id);
      }
    }
    const run = this.#runs.get(owner) ?? openRun(now);
    run.lastAt = now;
    this.#runs.set(owner, run);
    this.#last = owner;
  }

  /** An agent call ended. The first one that left a verdict sets the time to the first verdict. */
  after(now: number, owner?: string): void {
    const run = this.#run(owner);
    if (run === undefined) {
      return;
    }
    run.lastAt = Math.max(run.lastAt, now);
    if (0 < run.verdicts.length || 0 < run.replayed.size) {
      run.firstVerdictAt ??= now;
    }
  }

  /** A journal record from the agent's own call. A record with no verdict is not a claim. */
  verdict(action: JournalAction): void {
    const run = this.#run();
    if (run === undefined || action.drivenBy !== undefined) {
      return;
    }
    // A replay is counted once, as a flow, decided as its run decides it (`replayed`). Its journal
    // record said `unknown` where the run said `no`, and one report gave both answers.
    if (ReticleTool.FLOW_REPLAY === action.tool) {
      return;
    }
    const parsed = JournalVerdictEffectSchema.safeParse(action.effect);
    if (parsed.success) {
      run.verdicts.push(parsed.data);
    }
  }

  flowSaved(name: string): void {
    this.#run()?.saved.add(name);
  }

  /** The last replay of a flow in this run is its verdict. */
  replayed(name: string, verified: Verified): void {
    this.#run()?.replayed.set(name, verified);
  }

  memoryWritten(count = 1): void {
    const run = this.#run();
    if (run !== undefined) {
      run.written += count;
    }
  }

  /** Notes given to the agent. Each one counts once, however often it is shown. */
  memoryRead(notes: readonly string[]): void {
    const run = this.#run();
    if (run === undefined) {
      return;
    }
    for (const note of notes) {
      run.read.add(note);
    }
  }

  isEmpty(owner?: string): boolean {
    return this.#run(owner) === undefined;
  }

  /** The named owner, else the calling connection, else the agent that called last. */
  #owner(owner: string | undefined): string | undefined {
    return owner ?? callingAttachId() ?? this.#last;
  }

  /**
   * The run a record belongs to. None while no agent call has begun one: a CLI `reticle verify`
   * replays through the same code, and what it did is not the next agent's run.
   */
  #run(owner?: string): Run | undefined {
    const id = this.#owner(owner);
    return id === undefined ? undefined : this.#runs.get(id);
  }

  /** The owner's report, without the cloud line (the caller knows the project). Ends that run. */
  take(now: number, owner?: string): RunReport {
    const id = this.#owner(owner);
    const run = this.#run(owner) ?? openRun(now);
    if (id !== undefined) {
      this.#runs.delete(id);
    }
    const started = run.startedAt;
    // A passive check that read too early is not counted: the rule every fold applies.
    const superseded = supersededChecks(
      run.verdicts.map((v) => ({
        key: v.claim,
        passive: false === v.declaredBeforeActing,
        held: Verified.YES === v.verified,
        failed: Verified.NO === v.verified,
      })),
    );
    const counted = run.verdicts.filter((_, at) => !superseded.has(at));
    const claims = counted.map((v): RunReportClaim => {
      const evidence = evidenceOf(v);
      return evidence === undefined
        ? { claim: v.claim, verified: v.verified }
        : { claim: v.claim, verified: v.verified, evidence };
    });
    const replayed = [...run.replayed].map(([name, verified]) => ({ name, verified }));
    return {
      verified: runVerified([...claims.map((c) => c.verified), ...replayed.map((r) => r.verified)]),
      claims,
      caught: [
        ...claims.filter((c) => Verified.NO === c.verified).map((c) => c.claim),
        ...replayed.filter((r) => Verified.NO === r.verified).map((r) => `${FLOW}${r.name}`),
      ],
      flows: { saved: [...run.saved], replayed },
      memory: { written: run.written, read: run.read.size },
      wallMs: Math.max(0, now - started),
      ...(run.firstVerdictAt === undefined
        ? {}
        : { firstVerdictMs: Math.max(0, run.firstVerdictAt - started) }),
    };
  }
}

/** The daemon's ledger. */
export const runLedger = new RunLedger();
