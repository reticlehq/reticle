/**
 * The self-heal state machine — load → replay → collect confident proposals → (apply ? verify+write:
 * dry). Split out of flow-tools.ts (which keeps only the FLOW_HEAL ToolDef) as a sibling of
 * flow-replay-run.ts. Never silently rewrites: only proposals that cleared HEAL_CONFIDENCE_MIN are
 * eligible, and only when apply:true; before persisting it re-verifies the success consequence still
 * fires (heal the locator, never the intent).
 */
import {
  FLOW_SIGNAL_TIMEOUT_MS,
  HEAL_CONFIDENCE_MIN,
  HealStatus,
  ReplayStatus,
  type FlowHealResult,
  type HealChange,
  type HealProposal,
} from '@reticlehq/core';
import { asString, DriftReason, isConsequenceDrift } from '@reticlehq/core';
import { waitForPredicate } from '@reticlehq/engine/question/predicate/predicate.js';
import { replayFlow } from './flow-replay.js';
import { applyHealChanges, collectProposals } from './heal.js';
import { healPrecondition } from './heal-precondition.js';
import { assertSuccess, dynamicTestids, successLabel } from './flow-success.js';
import { flowErrorMessage } from './flow-replay-run.js';
import { sessionTarget } from '@/memory/project/session-root.js';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';
import { flowsForSession } from './flow-store-for-session.js';

const HEAL_MESSAGES = {
  NOTHING: 'nothing to heal — every anchor resolved on replay',
  HEALED:
    "rewrote drifted testid anchors to their nearest surviving match and re-verified the flow's success consequence still fires",
  DRIFT_DRY: 'confident rebind(s) proposed — re-run with apply:true to write them to disk',
  UNHEALABLE: `drift found, but no nearest match cleared the confidence floor (HEAL_CONFIDENCE_MIN=${HEAL_CONFIDENCE_MIN}); file left untouched; add a data-testid or fix the flow by hand`,
  /**
   * Heal can only rebind a locator, and not every drift is one.
   *
   * Reported as a confidence failure until it was measured: a flow whose EXPECTATION stopped
   * appearing exits `proposeRebindWith` at its first line, before any candidate is scored, and the
   * old message still named the floor — so replay confidently naming a survivor and heal citing a
   * threshold read as the two disagreeing about the same candidate. They were answering different
   * questions.
   */
  NOT_A_REBIND:
    'drift found, but none of it is a renamed locator, so there is nothing to rebind — the anchors resolved and what failed was what the steps assert afterwards. The confidence floor was never consulted. Fix the app so the consequence fires again, or update the step expectations by hand',
  ANCHOR_UNRESOLVED:
    'drift found, but a step anchor did not resolve on the page, so the step did not run. Heal does not rebind this kind of anchor, and the confidence floor was not used. Update the step anchor by hand',
  ANCHOR_NEAREST_PREFIX: 'The nearest candidate on the page is',
  HEALED_UNVERIFIED:
    "rewrote drifted testid anchors. This flow declares its consequences per STEP rather than as a flow `success`, so the rebind was not re-verified end to end — the steps will assert on the next replay, but nothing proved the healed flow still reaches its outcome. Set the flow's `success` (reticle_annotate) to have future heals re-verified before they are written.",
  CONSEQUENCE_BROKEN:
    'rebind resolves the drifted locator to a surviving element, but the healed flow no longer satisfies its success consequence — refusing to write (a heal that loses the intent would ship a green-but-dead test). Fix by hand and verify',
} as const;

/**
 * Why heal produced no proposal. Three cases.
 *
 * A testid anchor drifted, but no candidate cleared the confidence floor: UNHEALABLE.
 * Every drift is a consequence (the anchors resolved, the assertion failed): NOT_A_REBIND.
 * Any other drift means an anchor did not resolve, so the step did not run: ANCHOR_UNRESOLVED.
 * That message names the nearest candidate when there is one.
 *
 * Exported for its own test. A reader acts on this sentence, and the wrong one sends them to
 * lower a threshold that had no part in the refusal.
 */
export function unhealableMessage(
  reasons: readonly DriftReason[],
  nearest: string | null = null,
): string {
  if (reasons.some((reason) => DriftReason.TESTID_NOT_FOUND === reason)) {
    return HEAL_MESSAGES.UNHEALABLE;
  }
  if (reasons.every((reason) => isConsequenceDrift(reason))) {
    return HEAL_MESSAGES.NOT_A_REBIND;
  }
  return null === nearest
    ? HEAL_MESSAGES.ANCHOR_UNRESOLVED
    : `${HEAL_MESSAGES.ANCHOR_UNRESOLVED}. ${HEAL_MESSAGES.ANCHOR_NEAREST_PREFIX} "${nearest}".`;
}

function toChange(proposal: HealProposal): HealChange {
  return { step: proposal.step, from: proposal.from, to: proposal.to };
}

export async function healFlow(
  deps: ToolDeps,
  args: Record<string, unknown>,
): Promise<FlowHealResult> {
  // `flow` is the alias the tool's schema offers; ignoring it healed a flow named "".
  const name = asString(args['flowName']) ?? asString(args['flow']) ?? '';
  const apply = true === args['apply'];
  const target = sessionTarget(deps, asString(args['sessionId']));
  const { projectId } = target;
  const loaded = await flowsForSession(deps, target).flows.load(name, projectId);
  if (!loaded.ok) {
    return {
      name,
      status: HealStatus.ERROR,
      applied: false,
      proposals: [],
      changed: [],
      message: flowErrorMessage(loaded.code, loaded.detail),
      error: { code: loaded.code, message: flowErrorMessage(loaded.code, loaded.detail) },
    };
  }

  const session = deps.sessions.resolve(asString(args['sessionId']));
  const steps = await replayFlow(
    session,
    loaded.value,
    waitForPredicate,
    FLOW_SIGNAL_TIMEOUT_MS,
    true === args['confirmDangerous'],
  );
  const drifted = steps.some((s) => s.drift !== undefined);
  const failed = steps.find((s) => !s.ok && s.drift === undefined);
  if (failed !== undefined) {
    const message = failed.error ?? 'flow replay failed before an anchor could be healed';
    return {
      name,
      status: HealStatus.ERROR,
      applied: false,
      proposals: [],
      changed: [],
      message,
      error: { code: ReplayStatus.ERROR, message },
    };
  }
  if (!drifted) {
    return {
      name,
      status: HealStatus.NOTHING_TO_HEAL,
      applied: false,
      proposals: [],
      changed: [],
      message: HEAL_MESSAGES.NOTHING,
    };
  }

  const proposals = collectProposals(steps);
  if (0 === proposals.length) {
    const drifts = steps.flatMap((step) => (step.drift === undefined ? [] : [step.drift]));
    return {
      name,
      status: HealStatus.UNHEALABLE,
      applied: false,
      proposals: [],
      changed: [],
      message: unhealableMessage(
        drifts.map((drift) => drift.reasonKind),
        drifts.find((drift) => !isConsequenceDrift(drift.reasonKind) && null !== drift.nearest)
          ?.nearest ?? null,
      ),
    };
  }

  if (!apply) {
    return {
      name,
      status: HealStatus.DRIFT,
      applied: false,
      proposals,
      changed: [],
      message: HEAL_MESSAGES.DRIFT_DRY,
    };
  }

  /*
   * A flow with no consequence may not be healed at all.
   *
   * The rebind is checked by the CONSEQUENCE: a locator healed to the wrong element cannot fake a
   * signal, a request or a store value. A flow that asserts nothing has nothing to check it against,
   * so healing it yields a flow that passes forever and proves nothing — worse than the drift it
   * replaced, because the drift was at least visible. Presence-only is refused for the sharpest
   * version of the same reason: "the element is there" is exactly what a wrong rebind makes true.
   *
   * This used to heal and say "the rebind is unverified" in the message, which put the one sentence
   * that mattered where an agent reads it after banking a green.
   *
   * Refused at the WRITE, not before the replay: the drift is real, and a human may well want to
   * fix it by hand, so the proposal still travels. Same split as CONSEQUENCE_BROKEN.
   */
  const unfalsifiable = healPrecondition(loaded.value);
  if (unfalsifiable !== undefined) {
    return {
      name,
      status: unfalsifiable.status,
      applied: false,
      proposals,
      changed: [],
      message: unfalsifiable.message,
    };
  }

  // Heal the locator, never the intent: verify the rebind on a healed copy before persisting. A rebound
  // testid can resolve to a real but WRONG element that no longer triggers the success consequence.
  const { flow: healed } = applyHealChanges(loaded.value, proposals.map(toChange));
  if (healed.success !== undefined) {
    // Verify from the FIRST DRIFTED step forward, not the whole flow — re-running the prefix would
    // double-execute a non-idempotent flow (a false CONSEQUENCE_BROKEN that refuses a correct heal).
    const firstDrift = steps.findIndex((s) => s.drift !== undefined);
    const toVerify = firstDrift > 0 ? { ...healed, steps: healed.steps.slice(firstDrift) } : healed;
    // Floor the success oracle at the start of the VERIFY replay so the earlier drift replay's signal
    // cannot fake the verification.
    const verifyFloor = session.elapsed();
    const verifySteps = await replayFlow(
      session,
      toVerify,
      waitForPredicate,
      FLOW_SIGNAL_TIMEOUT_MS,
      true === args['confirmDangerous'],
    );
    const verifyClean =
      verifySteps.length > 0 && verifySteps.every((s) => s.ok && s.drift === undefined);
    const verdict = verifyClean
      ? await assertSuccess(
          session,
          healed.success,
          dynamicTestids(healed),
          waitForPredicate,
          FLOW_SIGNAL_TIMEOUT_MS,
          verifyFloor,
        )
      : { pass: false, failureReason: 'healed flow did not replay cleanly' };
    if (!verdict.pass) {
      return {
        name,
        status: HealStatus.CONSEQUENCE_BROKEN,
        applied: false,
        proposals,
        changed: [],
        message: `${HEAL_MESSAGES.CONSEQUENCE_BROKEN} (${successLabel(healed.success)}: ${verdict.failureReason ?? 'not satisfied'})`,
      };
    }
  }

  // Healing WRITES, so it must land where the load came from — a heal that read the app's flow and
  // wrote the daemon's copy would silently fork the two.
  const written = await flowsForSession(deps, target).flows.heal(
    name,
    proposals.map(toChange),
    projectId,
  );
  if (!written.ok) {
    return {
      name,
      status: HealStatus.ERROR,
      applied: false,
      proposals,
      changed: [],
      message: flowErrorMessage(written.code),
      error: { code: written.code, message: flowErrorMessage(written.code) },
    };
  }
  return {
    name,
    status: HealStatus.HEALED,
    applied: written.value.changed.length > 0,
    proposals,
    changed: written.value.changed,
    message:
      loaded.value.success !== undefined ? HEAL_MESSAGES.HEALED : HEAL_MESSAGES.HEALED_UNVERIFIED,
  };
}
