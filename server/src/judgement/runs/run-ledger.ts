/**
 * The run ledger: what each agent run checked, saved and read, kept until its report is taken.
 *
 * A run is one agent's calls from its first Reticle call to the call that ends it (a session end, a
 * yield, a released tab). The verdicts come from the journal records the agent's own calls wrote;
 * the Harness's are never counted. Taking the report ends that run, so the agent's next run starts
 * at zero.
 *
 * The ledger keeps one run for each `(sessionId, root)` identity. Attach IDs, project IDs, and roots
 * describe different scopes. Events without a matching identity do not join another run.
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
export interface RunIdentity {
  sessionId: string;
  root: string;
}

function runIdentityKey(identity: RunIdentity): string {
  return JSON.stringify([identity.sessionId, identity.root]);
}

export class RunLedger {
  readonly #runs = new Map<string, Run>();

  /** An agent call starts. The agent's first call starts its run. A run idle too long is dropped. */
  begin(now: number, identity: RunIdentity): void {
    const owner = runIdentityKey(identity);
    for (const [id, run] of this.#runs) {
      if (now - run.lastAt > RUN_IDLE_LIMIT_MS) {
        this.#runs.delete(id);
      }
    }
    const run = this.#runs.get(owner) ?? openRun(now);
    run.lastAt = now;
    this.#runs.set(owner, run);
  }

  /** An agent call ended. The first one that left a verdict sets the time to the first verdict. */
  after(now: number, identity: RunIdentity): void {
    const run = this.#run(identity);
    if (run === undefined) {
      return;
    }
    run.lastAt = Math.max(run.lastAt, now);
    if (0 < run.verdicts.length || 0 < run.replayed.size) {
      run.firstVerdictAt ??= now;
    }
  }

  /** A journal record from the agent's own call. A record with no verdict is not a claim. */
  verdict(action: JournalAction, identity: RunIdentity): void {
    const run = this.#run(identity);
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

  flowSaved(name: string, identity: RunIdentity): void {
    this.#run(identity)?.saved.add(name);
  }

  /** The last replay of a flow in this run is its verdict. */
  replayed(name: string, verified: Verified, identity: RunIdentity): void {
    this.#run(identity)?.replayed.set(name, verified);
  }

  memoryWritten(identity: RunIdentity, count = 1): void {
    const run = this.#run(identity);
    if (run !== undefined) {
      run.written += count;
    }
  }

  /** Notes given to the agent. Each one counts once, however often it is shown. */
  memoryRead(notes: readonly string[], identity: RunIdentity): void {
    const run = this.#run(identity);
    if (run === undefined) {
      return;
    }
    for (const note of notes) {
      run.read.add(note);
    }
  }

  isEmpty(identity: RunIdentity): boolean {
    return this.#run(identity) === undefined;
  }

  /** The composite identity for strict lookup and removal. */
  #owner(identity: RunIdentity): string {
    return runIdentityKey(identity);
  }

  /**
   * The run a record belongs to. None while no agent call has begun one: a CLI `reticle verify`
   * replays through the same code, and what it did is not the next agent's run.
   */
  #run(identity: RunIdentity): Run | undefined {
    return this.#runs.get(this.#owner(identity));
  }

  /** The owner's report, without the cloud line (the caller knows the project). Ends that run. */
  take(now: number, identity: RunIdentity): RunReport {
    const id = this.#owner(identity);
    const run = this.#run(identity) ?? openRun(now);
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
