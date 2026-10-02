import { AnomalyKind, AnomalyTier, type Anomaly, type Observation } from 'open-verification';
import { CliChannel } from './channels.js';
import { CliSummary } from './cli-realm.js';

/**
 * Two things in one window that cannot both be true.
 *
 * Kept out of `CliRealm` because every rule here is a pure function of a window's observations:
 * no clock, no filesystem, no process. That makes each one testable on its own, and it makes the
 * set extensible without touching the realm, which is the open/closed shape the engine's own
 * contradiction folds already use.
 *
 * ## The tier is the whole of the care
 *
 * Clause 3 of the adjudication order runs BEFORE the window check and before the coverage check.
 * So an `observed`-tier anomaly convicts before `still-in-flight` or a dirty `closedBy` is ever
 * consulted, and a tool that forks, returns, and lands its effect a second later would be
 * convicted for behaving correctly.
 *
 * The rule the specification states and this file obeys: "the thing I expected had not happened
 * yet when I stopped looking" is NOT "it did not happen". Anything derived from an absence is
 * `absence-derived`, may downgrade a verdict to `unknown`, and may never force a `no`.
 *
 * Only one rule here is `observed`, and it is the one where an independent channel positively saw
 * something: the operating system ended the process while the tool was announcing success.
 */

/** Words a tool uses when it believes it did something. Deliberately few, and deliberately dumb. */
const SUCCESS_WORDS: readonly string[] = [
  'success',
  'succeeded',
  'done',
  'complete',
  'completed',
  'wrote',
  'created',
  'generated',
  'built',
  'updated',
  'finished',
  '✓',
  '✔',
];

/**
 * Did the tool's own output claim it did something?
 *
 * A HEURISTIC over prose, and it is only ever allowed to raise a suspicion -- never to decide
 * anything on its own. That is why every rule built on it is absence-derived or needs an
 * independent channel to agree: matching English is not evidence, and a verifier that convicted on
 * a substring would be reading the subject's prose as though it were a fact.
 */
function claimsSuccess(observations: readonly Observation[]): string | undefined {
  for (const observation of observations) {
    if (observation.channel !== CliChannel.LOG) continue;
    const text = 'string' === typeof observation.value ? observation.value : '';
    const lower = text.toLowerCase();
    if (SUCCESS_WORDS.some((word) => lower.includes(word))) return text;
  }
  return undefined;
}

const on = (observations: readonly Observation[], channel: string): readonly Observation[] =>
  observations.filter((o) => o.channel === channel);

/**
 * The tool announced success and the operating system killed it.
 *
 * The only OBSERVED-tier rule here, and it is entitled to convict because `x-proc` is independent:
 * the kernel decided the ending and the tool had no say. This pairing is the entire reason the
 * exit status is split across two channels. Merged into one, this would be two actuation-derived
 * channels disagreeing, which `disagreementCanConvict` correctly refuses to act on -- and a real
 * crash would be unreportable as a fault.
 */
function claimedOverKill(observations: readonly Observation[]): Anomaly | undefined {
  const killed = on(observations, CliChannel.PROCESS).find(
    (o) => o.summary === CliSummary.TERMINATED_SIGNAL,
  );
  if (killed === undefined) return undefined;
  const claim = claimsSuccess(observations);
  if (claim === undefined) return undefined;
  return {
    kind: AnomalyKind.CLAIMED_OVER_FAILURE,
    tier: AnomalyTier.OBSERVED,
    claim: `the tool reported: ${claim}`,
    counter: `the operating system ended it with ${String(killed.value)}, which the tool did not choose`,
    between: [CliChannel.LOG, CliChannel.PROCESS],
    evidence: [killed.id],
  };
}

/**
 * The tool said it wrote something and the filesystem recorded nothing.
 *
 * Absence-derived, not observed, and the difference is a tool that forks. A command that returns
 * while a child is still writing has produced exactly this shape, and it is working correctly;
 * convicting it would make every daemonising CLI permanently unprovable.
 */
function claimedWriteNeverLanded(observations: readonly Observation[]): Anomaly | undefined {
  const claim = claimsSuccess(observations);
  if (claim === undefined) return undefined;
  if (on(observations, CliChannel.ARTIFACT).length > 0) return undefined;
  return {
    kind: AnomalyKind.ADVANCED_OVER_FAILURE,
    tier: AnomalyTier.ABSENCE_DERIVED,
    claim: `the tool reported: ${claim}`,
    counter:
      'nothing was recorded on the filesystem inside this window; the effect may be outside the ' +
      'declared roots, in a child process, or still to land',
    between: [CliChannel.LOG, CliChannel.ARTIFACT],
    evidence: [],
  };
}

/**
 * The action was delivered and nothing anywhere recorded anything.
 *
 * Absence-derived for the same reason: silence inside a window whose end WE chose is not proof
 * that nothing happened. It is a reason to look again, which is exactly what `unknown` tells a
 * caller to do.
 */
function noTraceAtAll(observations: readonly Observation[]): Anomaly | undefined {
  if (observations.length > 0) return undefined;
  return {
    kind: AnomalyKind.NO_EFFECT,
    tier: AnomalyTier.ABSENCE_DERIVED,
    claim: 'the command was dispatched',
    counter: 'no channel recorded anything at all before the window closed',
    between: [CliChannel.LOG, CliChannel.ARTIFACT],
    evidence: [],
  };
}

/**
 * A host the command said it would reach, and no connection to it in the window.
 *
 * The rule the proxy exists for, and the one a shell can never implement: an agent with `Bash`
 * cannot see that a command never called out. `exit 0` and a confident line of output look
 * identical whether the request went or not.
 *
 * Absence-derived, like everything else built on a silence. A dial that happened after the window
 * closed, or through a route the proxy does not sit on, produces this shape while the tool is
 * working correctly -- so it may downgrade a verdict to `unknown` and may never force a `no`.
 */
function neverDialled(
  observations: readonly Observation[],
  expected: readonly string[],
): Anomaly | undefined {
  if (0 === expected.length) return undefined;
  const dialled = new Set(
    on(observations, CliChannel.NET).map((o) =>
      'object' === typeof o.value && null !== o.value
        ? String((o.value as { host?: unknown }).host)
        : '',
    ),
  );
  const missed = expected.filter((host) => !dialled.has(host));
  if (0 === missed.length) return undefined;
  return {
    kind: 'x-never-dialled',
    tier: AnomalyTier.ABSENCE_DERIVED,
    claim: `the command was declared to reach ${missed.join(', ')}`,
    counter: 'no connection to it was seen before the window closed',
    between: [CliChannel.NET, CliChannel.LOG],
    evidence: [],
  };
}

/**
 * The rules, as a list, so adding one is adding a function.
 *
 * Each takes a window's observations and returns an anomaly or nothing. None of them reads a
 * clock, a disk or a process, which is what keeps them testable and what stops a rule quietly
 * becoming a second observer.
 */
const RULES: readonly ((o: readonly Observation[]) => Anomaly | undefined)[] = [
  claimedOverKill,
  claimedWriteNeverLanded,
  noTraceAtAll,
];

/** Every disagreement these rules can see in one window. */
export interface DetectContext {
  /** Hosts the command under test declared it would reach. Empty means it declared none. */
  readonly reaches?: readonly string[];
}

/** Every disagreement these rules can see in one window. */
export function detectAnomalies(
  observations: readonly Observation[],
  context: DetectContext = {},
): readonly Anomaly[] {
  return [
    ...RULES.map((rule) => rule(observations)),
    neverDialled(observations, context.reaches ?? []),
  ].filter((a): a is Anomaly => undefined !== a);
}
