import {
  CHANNEL_DEFAULTS,
  ChannelId,
  CloseCondition,
  Grade,
  Independence,
  Realm,
  RefusalReason,
  BlindSpotKind,
  type Anomaly,
  type BlindSpot,
  type Action,
  type ActionReceipt,
  type Capability,
  type ChannelDescriptor,
  type Coverage,
  type DeterminismProfile,
  type Observation,
  type SubjectRef,
  type Window,
} from 'open-verification';
import { CliChannel } from './channels.js';
import { detectAnomalies } from './detect.js';
import { commandNamed, type CommandManifest } from './manifest.js';
import type { Invocation, Supervisor } from './supervisor.js';
import {
  ChangeKind,
  diffSnapshots,
  type Change,
  type Snapshot,
  type WorkspacePort,
} from './workspace.js';

/**
 * A realm for a subject that runs and exits.
 *
 * The first adapter in this project that is NOT a pair. A browser realm is half an SDK inside the
 * subject and half a daemon outside it, because a page cannot photograph itself; this one spawns
 * the process and watches from the outside, so there is nothing to install into the subject and no
 * build system to be compatible with. Everything it knows, it knows without the tool's cooperation.
 *
 * That caps it as well. No code inside the subject means no `state` and no `signal` from the tool's
 * own world, so it can never reach the `in-realm` profile, and it should say so at startup rather
 * than discover it one `unknown` at a time.
 *
 * It never touches the operating system. Everything arrives through `Supervisor`, which is what
 * makes the interesting cases -- a kill, a fork, a process that never ends -- testable without
 * arranging for one to happen.
 */

/** The surface name. Not a new named surface in the protocol: `x-` is the sanctioned answer. */
const CLI_SURFACE = 'x-cli';

/** Observation summaries. Stable machine labels, because `valueContains` matches on them exactly. */
export const CliSummary = {
  STDOUT_LINE: 'cli.stdout.line',
  STDERR_LINE: 'cli.stderr.line',
  EXIT_CODE: 'cli.exit.code',
  TERMINATED_SIGNAL: 'cli.terminated.signal',
  DURATION_MS: 'cli.duration.ms',
  /** A path that appeared, vanished or changed mode. What the FILESYSTEM decided. */
  FS_WRITTEN: 'cli.fs.written',
  FS_DELETED: 'cli.fs.deleted',
  /** The bytes inside a path. What the SUBJECT decided, which is why it is a different channel. */
  FS_CONTENT: 'cli.fs.content',
} as const;

/**
 * What this realm can see, and what each is worth HERE.
 *
 * Two entries sit below `CHANNEL_DEFAULTS`, and section 3 permits exactly that direction: an
 * implementation may declare a channel less trustworthy than the table and never more.
 *
 * `log` is the interesting one. The table marks it INDEPENDENT, reasoning that an uncaught
 * exception reaches the log stream without the application choosing to report it. For a
 * command-line tool that is backwards: stdout is deliberate output, written by the same code path
 * that did the work. `✓ built successfully` is the handler saying the handler ran.
 *
 * `signal` carries the exit code, dropped from consequence to presence, and that one line is the
 * most useful thing this adapter has to say to anybody verifying a CLI today: `assert exitCode ===
 * 0` becomes evidence that cannot buy a `yes`.
 */
const CLI_CHANNELS: readonly ChannelDescriptor[] = [
  {
    id: CliChannel.LOG,
    independence: Independence.ACTUATION_DERIVED,
    grade: Grade.CONTEXT,
    note: 'stdout and stderr, which a command-line tool writes on purpose',
  },
  {
    id: CliChannel.EXIT_STATUS,
    independence: Independence.ACTUATION_DERIVED,
    grade: Grade.PRESENCE,
    note: 'the exit code the tool chose for itself',
  },
  {
    id: CliChannel.PROCESS,
    independence: Independence.INDEPENDENT,
    grade: Grade.PRESENCE,
    note: 'termination imposed by the operating system, which the tool did not choose',
  },
  {
    id: CliChannel.TIME,
    ...CHANNEL_DEFAULTS[ChannelId.TIME],
    note: 'duration, and whether it ended',
  },
];

/**
 * The filesystem, as TWO channels, which is the load-bearing claim of this adapter.
 *
 * The protocol's test for independence is not "can the subject be wrong about it". It is *"it is
 * the causing that decides this"* -- the reason a screenshot stays actuation-derived despite a
 * compositor, a GPU and a display that can all refuse it: the subject fully determines what it
 * rendered, so a photograph is an echo with a camera in the way.
 *
 * Applied honestly to a write, that question has two different answers:
 *
 *   WHETHER a path exists, its size, its mode -- decided by the filesystem. The tool requests;
 *   permissions, a full disk, a missing parent, a non-atomic rename or a case-fold collision
 *   decide. A later `lstat` is that party answering, which is structurally what `net` is.
 *
 *   WHAT IS INSIDE IT -- authored entirely by the subject. Nothing outside the tool's own code
 *   path decides a single byte.
 *
 * Declaring them as one channel at consequence grade would let a substring match over file content
 * buy a `yes`, and clause 9 could not catch it, because the evidence would carry the right
 * independence and the wrong provenance.
 *
 * The worked counter-example worth remembering: `git push` writes `.git/refs/remotes/origin/main`,
 * and the sha in it is git's TRANSCRIPTION of what it believes the remote said. Under one channel
 * that file would buy a `yes` for "the push landed". Under two it buys "git wrote a ref", which is
 * the truth. An artifact is consequence-grade about the local filesystem and never about the world.
 */
const ARTIFACT_CHANNELS: readonly ChannelDescriptor[] = [
  {
    id: CliChannel.ARTIFACT,
    independence: Independence.INDEPENDENT,
    grade: Grade.CONSEQUENCE,
    note: 'that a path exists, its size and its mode, which the filesystem decided',
  },
  {
    id: CliChannel.ARTIFACT_CONTENT,
    independence: Independence.ACTUATION_DERIVED,
    grade: Grade.PRESENCE,
    note: 'the bytes inside a path, which the subject authored entirely',
  },
];

export interface CliRealmDeps {
  readonly supervisor: Supervisor;
  readonly manifest: CommandManifest;
  /**
   * Where the subject leaves things behind, when there is somewhere to watch.
   *
   * Absent is a real answer and not a degraded one: without it the realm declares no artifact
   * channel, `canProveAnything` is false, and it says so at startup rather than one `unknown` at a
   * time. Declaring a channel it cannot report on would be the costlier kind of wrong.
   */
  readonly workspace?: WorkspacePort;
  /** Injected, never read from a global: a window's arithmetic must be reproducible in a test. */
  readonly now: () => number;
}

export class CliRealm extends Realm {
  readonly #deps: CliRealmDeps;
  #windowSeq = 0;
  /**
   * What was on disk when each window opened.
   *
   * Held per window rather than as one "last snapshot", because two windows can overlap and a
   * single slot would silently answer the second window's questions with the first window's
   * before-state.
   */
  readonly #before = new Map<string, Snapshot>();

  constructor(deps: CliRealmDeps) {
    super();
    this.#deps = deps;
  }

  /**
   * The installed tool and the workspace, never the process.
   *
   * A CLI's process is the action, so naming it as the instance would make every observation from
   * step one inadmissible at step two and report a working journey as evidence superseded. The
   * thing that PERSISTS across the invocations of a journey is the tool plus what it operates on.
   */
  identity(): SubjectRef {
    const tool = this.#deps.supervisor.toolIdentity();
    return {
      surface: CLI_SURFACE,
      instance: `${tool.id}@${tool.version}#${tool.workspace}`,
      ...(tool.epoch === undefined ? {} : { epoch: tool.epoch }),
      ...(tool.revision === undefined ? {} : { revision: tool.revision }),
      locator: this.#deps.manifest.workspaceRoot,
    };
  }

  /**
   * What is declared follows what is actually present, never what would look better.
   *
   * The artifact pair appears only with a workspace to watch. That is the same discipline the
   * optional fixture and mutation ports carry elsewhere: a realm must not OFFER what it cannot
   * honour, because a channel declared and never reported on makes every claim reading it come
   * back `unknown` while the implementation looks capable.
   */
  channels(): readonly ChannelDescriptor[] {
    return this.#deps.workspace === undefined
      ? CLI_CHANNELS
      : [...CLI_CHANNELS, ...ARTIFACT_CHANNELS];
  }

  /**
   * How this subject may be DRIVEN, derived from the manifest rather than asserted.
   *
   * `replayPrefix` is the row that earns its place. A prefix of read-only, uncostly commands is
   * genuinely safe to re-drive; one containing a `deploy`, or a billed query, is not. `unsafe` is
   * not a cost to weigh against a cheap reset, and `resumeStrategy` reads it first and alone for
   * that reason: reading the reset first and concluding "cheap reset, so go ahead" is precisely
   * the reasoning that re-sends the payment.
   */
  determinism(): DeterminismProfile {
    const replayable = this.#deps.manifest.commands.every((c) => !c.mutating && c.costly !== true);
    return {
      // No fixture port yet, and claiming a reset with nothing to restore from is the lie that
      // makes a suite pass because the PREVIOUS flow left the right state behind.
      reset: 'none',
      replayPrefix: replayable ? 'costly' : 'unsafe',
      time: 'wall',
      observation: 'exact',
      actions: 'irreversible',
    };
  }

  capabilities(): readonly Capability[] {
    return this.#deps.manifest.commands.map((c) => ({
      name: c.name,
      meaning: c.meaning,
      mutating: c.mutating,
      ...(c.parameters === undefined ? {} : { parameters: c.parameters }),
    }));
  }

  /** What is here: the commands, and where they operate. No screen, no elements. */
  describe(): Promise<unknown> {
    return Promise.resolve({
      subject: this.identity(),
      workspace: this.#deps.manifest.workspaceRoot,
      commands: this.#deps.manifest.commands.map((c) => ({
        name: c.name,
        meaning: c.meaning,
        mutating: c.mutating,
      })),
    });
  }

  protected async dispatch(action: Action): Promise<ActionReceipt> {
    const command = commandNamed(this.#deps.manifest, action.capability);
    if (command === undefined) {
      // Unreachable through `perform`, which checks the declaration first. Kept because `dispatch`
      // is protected rather than private, and a subclass could reach it.
      return this.refuse(action, RefusalReason.UNDECLARED, `no command ${action.capability}`);
    }
    try {
      await this.#deps.supervisor.run(command.name, command.argv, DEFAULT_BUDGET_MS);
    } catch (error) {
      // Failing to REACH the tool is a refusal, not a verdict. Nothing was learned about the
      // tool's behaviour, only about our ability to run it.
      return this.refuse(action, RefusalReason.UNAVAILABLE, `could not run it: ${String(error)}`);
    }
    return {
      action: action.id,
      dispatched: true,
      subject: this.identity(),
      at: this.#deps.now(),
    };
  }

  /**
   * A window that closes when the process ends.
   *
   * `exit` is the cleanest close the protocol has: nothing inferred from silence, no deadline
   * chosen by us. A long-running command (`watch`, a dev server, a REPL) closes on quiescence
   * instead, which is Phase 4's problem and not a default to inherit here.
   */
  openWindow(budgetMs: number): Window {
    this.#windowSeq += 1;
    const id = `w${String(this.#windowSeq)}`;
    const workspace = this.#deps.workspace;
    // Taken HERE, before anything is dispatched, which is the only moment it is the before-state.
    // A snapshot taken at verification time would be the after-state wearing the other name.
    if (workspace !== undefined) this.#before.set(id, workspace.snapshot());
    return {
      id,
      openedAt: this.#deps.now(),
      budgetMs,
      closes: CloseCondition.EXIT,
      subject: this.identity(),
    };
  }

  /**
   * Was this path already there before the action? Three-valued, and the third value matters.
   *
   * `undefined` means NOBODY CHECKED, which the protocol reads differently from `false`, and a
   * realm with no workspace must say it rather than guess the answer that scores better.
   *
   * This is what lets a caller supply `consequenceHeldBefore` and reach clause 10. Without it the
   * commonest claim a CLI makes -- "the output file is there" -- is already true on every run
   * after the first, and a build that did nothing at all proves itself.
   */
  existedBefore(window: Window, path: string): boolean | undefined {
    const before = this.#before.get(window.id);
    return before === undefined ? undefined : before.files.has(path);
  }

  /** What changed on disk across this window, or nothing when there was nowhere to look. */
  changesIn(window: Window): readonly Change[] {
    const before = this.#before.get(window.id);
    const workspace = this.#deps.workspace;
    if (before === undefined || workspace === undefined) return [];
    return diffSnapshots(before, workspace.snapshot());
  }

  /**
   * Close it, saying what ACTUALLY ended it.
   *
   * Three outcomes and they are not interchangeable. The subject finished: `exit`. Something else
   * ended it: `terminated`, which is not a clean close because the effect may be half-applied and
   * the subject did not choose the moment. We gave up: `budget-exhausted`, which blames our
   * patience rather than the subject's misfortune, and is the honest answer when it is true.
   */
  closeWindow(window: Window): Window {
    const invocation = this.#latest(window);
    return {
      ...window,
      closedAt: this.#deps.now(),
      closedBy: closedBy(invocation),
    };
  }

  observe(window: Window): Promise<readonly Observation[]> {
    const observations: Observation[] = [];
    for (const invocation of this.#deps.supervisor.invocationsSince(window.openedAt)) {
      observations.push(...linesOf(window, invocation));
      observations.push(...endingOf(window, invocation));
    }
    observations.push(...artifactsOf(window, this.changesIn(window)));
    return Promise.resolve(observations);
  }

  /**
   * What this vantage point could not see, and in Phase 1 that is most things.
   *
   * `effect-elsewhere` is declared UNCONDITIONALLY rather than when a stray write is detected,
   * because nothing here can detect one: there is no filesystem observation yet, and even in
   * Phase 2 the roots are declared rather than discovered. A spot that can never fire would leave
   * every window silently asserting that nothing was hidden, which an empty `blindSpots` array
   * means as a positive claim.
   */
  /**
   * Two things in this window that cannot both be true.
   *
   * Delegates, because every rule is a pure function of the observations and belongs where it can
   * be tested without a realm. Implementing this at all is what makes section 8 reachable: the
   * specification records that a conformant implementation can be built in which the whole of
   * anomaly detection is unreachable, one was, and three planted defects came back `yes`.
   *
   * Safe for an adapter to do, because an anomaly is not a verdict. A disagreement may only
   * convict when one of its two channels is independent, and that check runs on the adjudicator's
   * side over the channel declaration, so a realm cannot convict itself however hard it tries.
   */
  override detect(_window: Window, observed: readonly Observation[]): Promise<readonly Anomaly[]> {
    return Promise.resolve(detectAnomalies(observed));
  }

  coverage(window: Window): Promise<Coverage> {
    const invocation = this.#latest(window);
    const workspace = this.#deps.workspace;
    return Promise.resolve({
      window: window.id,
      observed: this.channels().map((c) => c.id),
      blindSpots: [
        ...(workspace === undefined
          ? [
              {
                kind: BlindSpotKind.CHANNEL_UNOBSERVED,
                channel: CliChannel.ARTIFACT,
                detail: 'no workspace was declared, so nothing here can see what the tool wrote',
                impeaching: false,
                remedy: 'declare workspace roots so writes can be observed',
              },
            ]
          : [
              {
                // Declared UNCONDITIONALLY, and not "when a stray write was detected", because
                // nothing here can detect one: the roots are declared rather than discovered, so a
                // write to a home directory or a global cache is invisible by construction. A spot
                // that can never fire would leave every window silently asserting that nothing was
                // hidden, which an empty blindSpots array means as a positive claim.
                kind: BlindSpotKind.EFFECT_ELSEWHERE,
                detail:
                  `writes outside the declared roots (${workspace.roots.join(', ')}) are ` +
                  'unobserved, as are files written and removed inside the window, which a ' +
                  'before-and-after pair sees only the net effect of',
                impeaching: false,
                remedy: 'declare more roots, or narrow the claim to what is inside them',
              },
              ...unreadableSpots(workspace),
            ]),
        {
          kind: BlindSpotKind.CHANNEL_UNOBSERVED,
          channel: ChannelId.NET,
          detail: 'nothing here observes whether the tool called out',
          impeaching: false,
          remedy: 'run the subject through a recording proxy, or ask the far side afterwards',
        },
        {
          kind: BlindSpotKind.BOUNDARY_UNCROSSABLE,
          detail:
            'a child process the tool spawned is not traced, so anything it did, or anything that ' +
            'outlived the command, is invisible here',
          impeaching: false,
        },
        ...(invocation !== undefined && invocation.endedAt === undefined
          ? [
              {
                kind: BlindSpotKind.STILL_IN_FLIGHT,
                detail: 'the process was still running when the budget ran out',
                impeaching: true,
                remedy: 'raise the budget, or declare this command as long-running',
              },
            ]
          : []),
      ],
    });
  }

  /** The run this window is about, if there is one. */
  #latest(window: Window): Invocation | undefined {
    const seen = this.#deps.supervisor.invocationsSince(window.openedAt);
    return seen[seen.length - 1];
  }
}

/** How long a command is given when nothing said otherwise. */
const DEFAULT_BUDGET_MS = 120_000;

/**
 * What ended this window, from what the supervisor saw.
 *
 * A free function rather than a method: it reads an invocation and nothing else, so it is worth
 * being able to test without a realm, and worth being impossible to accidentally couple to one.
 */
export function closedBy(invocation: Invocation | undefined): CloseCondition {
  if (invocation?.exit === undefined) return CloseCondition.BUDGET_EXHAUSTED;
  return invocation.exit.wasSignalled ? CloseCondition.TERMINATED : CloseCondition.EXIT;
}

/** Output, per stream, in the order that stream produced it. */
function linesOf(window: Window, invocation: Invocation): Observation[] {
  const of = (lines: readonly { seq: number; text: string }[], summary: string): Observation[] =>
    lines.map((line) => ({
      id: `${window.id}-${invocation.id}-${summary}-${String(line.seq)}`,
      window: window.id,
      channel: CliChannel.LOG,
      at: invocation.startedAt,
      value: line.text,
      summary,
    }));
  return [
    ...of(invocation.stdout, CliSummary.STDOUT_LINE),
    ...of(invocation.stderr, CliSummary.STDERR_LINE),
  ];
}

/**
 * How it ended, split across the two channels that describe it honestly.
 *
 * The exit code goes on `signal` because the tool chose it. A kill goes on `x-proc` because the
 * operating system did. Reporting both on one channel would force a lie about one of them.
 *
 * The duration is emitted as a BARE NUMBER rather than a field inside a structure, because
 * `measure` reads `observation.value` when it is a number and deliberately will not reach into an
 * object: a path selector would be a predicate language arriving through the back door.
 */
function endingOf(window: Window, invocation: Invocation): Observation[] {
  const exit = invocation.exit;
  if (exit === undefined) return [];
  const at = invocation.endedAt ?? invocation.startedAt;
  const observations: Observation[] = [];
  if (exit.code !== undefined) {
    observations.push({
      id: `${window.id}-${invocation.id}-exit`,
      window: window.id,
      channel: CliChannel.EXIT_STATUS,
      at,
      value: exit.code,
      summary: CliSummary.EXIT_CODE,
    });
  }
  if (exit.signal !== undefined) {
    observations.push({
      id: `${window.id}-${invocation.id}-signal`,
      window: window.id,
      channel: CliChannel.PROCESS,
      at,
      value: exit.signal,
      summary: CliSummary.TERMINATED_SIGNAL,
    });
  }
  if (invocation.endedAt !== undefined) {
    observations.push({
      id: `${window.id}-${invocation.id}-duration`,
      window: window.id,
      channel: CliChannel.TIME,
      at,
      value: invocation.endedAt - invocation.startedAt,
      summary: CliSummary.DURATION_MS,
    });
  }
  return observations;
}

/**
 * What changed on disk, split across the two channels that describe it honestly.
 *
 * The path goes on `x-artifact` because the filesystem decided it. The bytes go on
 * `x-artifact-content` because the subject wrote them. A reader who only ever sees one of these
 * can still tell which kind of fact they are holding, which is the entire reason they are two.
 *
 * A mode change is reported as a write on the artifact channel: what the world may do with a file
 * is the filesystem's answer, and it is exactly the change an installer makes and a content hash
 * cannot see.
 */
function artifactsOf(window: Window, changes: readonly Change[]): Observation[] {
  const observations: Observation[] = [];
  for (const change of changes) {
    const deleted = ChangeKind.DELETED === change.kind;
    observations.push({
      id: `${window.id}-fs-${change.path}`,
      window: window.id,
      channel: CliChannel.ARTIFACT,
      at: window.openedAt,
      value: { path: change.path, kind: change.kind, size: change.after?.size },
      summary: deleted ? CliSummary.FS_DELETED : CliSummary.FS_WRITTEN,
    });
    const hash = change.after?.hash;
    if (hash !== undefined) {
      observations.push({
        id: `${window.id}-content-${change.path}`,
        window: window.id,
        channel: CliChannel.ARTIFACT_CONTENT,
        at: window.openedAt,
        value: { path: change.path, hash, was: change.before?.hash },
        summary: CliSummary.FS_CONTENT,
      });
    }
  }
  return observations;
}

/**
 * A root that could not be read, reported rather than treated as empty.
 *
 * IMPEACHING, unlike the other filesystem spots, and the difference is the point: not watching a
 * directory is a choice, while failing to read one you chose to watch means the evidence you were
 * counting on is simply absent. Reading it as "nothing was there" makes every absence claim over
 * that root true for a reason that has nothing to do with the subject.
 */
function unreadableSpots(workspace: WorkspacePort): BlindSpot[] {
  return workspace.snapshot().unreadable.map((root) => ({
    kind: BlindSpotKind.BOUNDARY_UNCROSSABLE,
    channel: CliChannel.ARTIFACT,
    detail: `the declared root ${root} could not be read, so nothing under it was observed`,
    impeaching: true,
    remedy: 'check the path exists and is readable by the verifier',
  }));
}
