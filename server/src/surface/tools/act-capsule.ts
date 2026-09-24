/**
 * Persist a failed assertion as a replayable fail-to-pass capsule.
 *
 * : a red assertion is the ONE moment the evidence explaining it is in hand. Persist it as a
        // replayable fail-to-pass capsule so the bug survives the turn — and becomes a regression flow
        // the moment it goes green. Best-effort: capturing evidence must never fail the run that found it.
 *
 * Split out of act-tools.ts when it crossed the 600-line cap. The seam is real: this is the only
 * part of the act path that writes to disk, and it is best-effort by design — capturing evidence
 * must never fail the run that found it.
 */
import { ActionType, AnchorKind } from '@reticlehq/core';
import {
  CapsuleStore,
  capsuleFingerprint,
  capsuleId,
  CAPSULE_VERSION,
} from '@/judgement/capsule/capsule-store.js';
import type { ExpectedLink } from '@/judgement/capsule/divergence.js';
import type { DivergenceCapsule } from '@/judgement/capsule/capsule.js';
import { ReticleTool } from '@reticlehq/core';
import { asRecord, asString } from '@reticlehq/core';
import type { ToolDeps } from './tool-kit.js';
import { sessionRoot } from '@/memory/project/session-root.js';

interface CapsuleSaveInputs {
  deps: ToolDeps;
  verdict: { pass: boolean; failureReason?: string };
  capsule?: DivergenceCapsule | undefined;
  links: readonly ExpectedLink[];
  args: Record<string, unknown>;
  actResult: { result?: unknown };
  actedSource?: { file: string; line: number };
  /**
   * The `.reticle` this capsule belongs in, from the session the act ACTUALLY drove.
   *
   * Passed in rather than re-resolved here, because re-resolving loses twice: `args.sessionId` is
   * frequently absent, and `sessions.resolve(undefined)` throws whenever more than one tab is
   * connected — which is precisely the multi-project case this routing exists for, so it failed in
   * exactly the situation it was written to fix. The caller also knows about a session the act
   * FOLLOWED through a navigation; this file cannot.
   */
  root?: string | undefined;
}

/** Returns the capsule id when one was written, or undefined when there was nothing to save. */
export async function saveFailedAssertCapsule(
  inputs: CapsuleSaveInputs,
): Promise<string | undefined> {
  const { deps, verdict, capsule, links, args, actResult, actedSource, root: given } = inputs;
  if (verdict.pass || capsule === undefined) return undefined;

  const expectedText = links
    .map((l) => ('name' in l ? `${l.kind} ${String(l.name)}` : l.kind))
    .join(' AND ');
  // The capsule belongs to the project whose app just failed, not to wherever the daemon stands.
  // Same rule and same resolver as every other artifact: a capsule written into a sibling repo is
  // evidence filed against a codebase that did not produce it, and it outlives the turn.
  // The caller's answer wins; the resolver is the fallback for callers that have no session.
  const root = given ?? bestEffortRoot(deps, asString(args['sessionId']));
  // No directory this capsule could honestly belong to, so it is not filed. The two things this
  // must not do are write it somewhere arbitrary and throw: the assertion has already failed, the
  // verdict is already built, and losing the capsule must never also lose the verdict.
  if (root === undefined) return undefined;
  // Built BEFORE the id, because the id carries the fingerprint of this body — that is what lets a
  // retry of the same broken step fold into the capsule already on disk instead of adding a file.
  const body = {
    version: CAPSULE_VERSION as typeof CAPSULE_VERSION,
    origin: 'failed-assert',
    expected: expectedText.length > 0 ? expectedText : 'declared consequence',
    observed: capsule.firstDivergence?.observed ?? verdict.failureReason ?? 'not observed',
    steps: [
      {
        tool: ReticleTool.ACT,
        anchor: {
          kind: AnchorKind.TESTID,
          value: asString(asRecord(actResult.result)['testid']) ?? asString(args['ref']) ?? '',
          // Carried so the saved capsule — which outlives this turn and becomes a regression flow
          // when it goes green — still knows which file the failure came from.
          ...(actedSource === undefined ? {} : { source: actedSource }),
        },
        action: (asString(args['action']) ?? ActionType.CLICK) as ActionType,
      },
    ],
  };
  const id = capsuleId(deps.now(), asString(args['ref']) ?? 'assert', capsuleFingerprint(body));
  const saved = await new CapsuleStore(deps.fs, root).save({
    ...body,
    id,
    createdAt: deps.now(),
  });
  return saved ? id : undefined;
}

/**
 * Where this capsule goes, or nothing — never a throw and never somebody else's checkout.
 *
 * `sessionRoot` refuses a `sessionId` that names no session, because for a tool the agent CALLED
 * the alternative is silently writing into the daemon's own project. Here the caller is not a tool
 * the agent called: it is the evidence capture hanging off a verdict that has already been decided,
 * and on this path a refusal would convert a red assertion into a tool error. Both of the answers
 * that refusal exists to prevent are still prevented — nothing is written, and nothing is written
 * to the wrong root — by declining to file the capsule at all.
 *
 * Reachable only when the act's own session AND its navigation successor are gone by the time the
 * verdict lands, since `act_and_wait` passes the root of the session it actually drove.
 */
function bestEffortRoot(deps: ToolDeps, sessionId: string | undefined): string | undefined {
  try {
    return sessionRoot(deps, sessionId);
  } catch {
    return undefined;
  }
}
