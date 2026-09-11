import { adjudicate, Declaration, type Claim, type Coverage } from '@reticlehq/openreality';
import { ProvenanceClass, type Evidence } from '@reticlehq/openreality';
import type { WebRealm } from './web-realm.js';

/**
 * The binding between the conformance driver and a live Reticle session.
 *
 * The suite has always said this piece was the reader's problem: *"`driveAll` takes a client with
 * three methods, and how those reach your implementation is your business, because we have never
 * seen your platform."* That is the right contract and it left the author in an awkward place —
 * we are also an implementation, and we had not written ours, so the suite could not be run
 * against the thing it was written from.
 *
 * This is ours. It is small on purpose: three methods over a `WebRealm`, no new rules, no second
 * adjudicator. Every verdict it returns comes from the specification's own `adjudicate`, so a
 * score produced through this is a score against the published rules rather than against
 * whatever Reticle happens to do.
 *
 * ── WHAT IT STILL CANNOT DO ─────────────────────────────────────────────────────────────────────
 * Plant a defect. The suite inverts that contract deliberately — it cannot inject a fault into an
 * application it does not own, so the implementation supplies a subject that answers
 * `x-conformance.plant`. Reticle's own fixture does not answer it yet, so a full self-score is
 * still out of reach and every scenario would come back ABSENT.
 *
 * That is the honest state and it is worth stating rather than hiding behind a client that
 * exists: the connection problem is solved here, the subject problem is not.
 */

/** What the driver needs, and nothing more. */
export interface ConformanceClient {
  hello(): Promise<{ channels: readonly string[]; commands: readonly string[] }>;
  command(name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  verify(claim: Claim): Promise<{ verdict: string; reason?: string }>;
}

/** How long a scenario's window is given before it is judged on what it saw. */
const WINDOW_BUDGET_MS = 8_000;

/**
 * Evidence from what the realm observed, at the grades its own channel declaration assigns.
 *
 * Built here rather than by the realm, because a realm that produced evidence would be grading
 * the weight of its own observations — the separation the specification exists to keep.
 */
function asEvidence(
  realm: WebRealm,
  observations: Awaited<ReturnType<WebRealm['observe']>>,
  at: number,
): Evidence[] {
  const declared = new Map(realm.channels().map((c) => [c.id, c]));
  const out: Evidence[] = [];
  for (const observation of observations) {
    const channel = declared.get(observation.channel);
    if (channel === undefined) continue; // observed on a channel we never declared: not evidence
    out.push({
      observation,
      provenance: {
        class: ProvenanceClass.OBSERVED,
        source: 'reticle',
        method: 'in-page instrumentation',
        subject: realm.identity(),
        at,
      },
      independence: channel.independence,
      grade: channel.grade,
    });
  }
  return out;
}

/**
 * A client the conformance driver can drive, over one live session.
 *
 * `verify` opens a window, observes it, and hands everything to the specification's adjudicator.
 * It deliberately does NOT consult Reticle's own verdict kernel: the point of a conformance run
 * is to score an implementation against the published rules, and scoring it against its own
 * rules would make every implementation conformant by construction.
 */
export function conformanceClient(realm: WebRealm, now: () => number): ConformanceClient {
  return {
    hello() {
      // Synchronous underneath: both answers are already declared. The interface is async for an
      // implementation that has to go and ask.
      return Promise.resolve({
        channels: realm.channels().map((c) => c.id),
        commands: realm.capabilities().map((c) => c.name),
      });
    },

    async command(name, args = {}) {
      const receipt = await realm.perform({
        id: `conformance-${String(now())}`,
        actor: 'conformance',
        capability: name,
        ...('string' === typeof args['ref'] ? { target: args['ref'] } : {}),
        parameters: args,
        at: now(),
      });
      // A refusal is reported as a refusal, never as a plant that quietly failed. The driver
      // scores an unplantable scenario ABSENT, which is the honest outcome and is never a pass.
      return receipt.dispatched
        ? { planted: true, ...args }
        : { planted: false, reason: receipt.refused?.detail ?? 'refused' };
    },

    async verify(claim) {
      const window = realm.openWindow(WINDOW_BUDGET_MS);
      const observations = await realm.observe(window);
      const coverage: Coverage = await realm.coverage(window);
      const decided = adjudicate({
        claim: { ...claim, declaredAt: claim.declaredAt ?? Declaration.BEFORE_ACTION },
        window: { ...window, closedAt: now(), closedBy: window.closes },
        channels: realm.channels(),
        evidence: asEvidence(realm, observations, now()),
        coverage,
        anomalies: [],
        // The suite plants a behaviour and asks what the implementation says about it; whether
        // the claim's own predicate held is the realm's answer, and this binding does not have
        // one to give. Undefined is "nobody evaluated it", which is what that means.
        assertionsHeld: undefined,
      });
      return {
        verdict: decided.verdict,
        ...(decided.reasons[0] === undefined ? {} : { reason: decided.reasons[0] }),
      };
    },
  };
}
