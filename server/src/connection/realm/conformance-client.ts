import {
  adjudicate,
  assertionsHeld,
  Declaration,
  type Claim,
  type Coverage,
} from '@reticlehq/openreality';
import { CloseCondition, Grade, ProvenanceClass, type Evidence } from '@reticlehq/openreality';
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
  /** How a person names a control, turned into a handle `command` will accept as `ref`. */
  locate(query: unknown): Promise<readonly { ref: string; describes: string }[]>;
  verify(claim: Claim): Promise<{ verdict: string; ground: string; reason?: string }>;
}

/**
 * The window has to be open BEFORE the action, and the first version of this got it backwards.
 *
 * `verify` opened a fresh window and observed it, which is a window containing nothing: the
 * action had already happened during the plant. Every scenario came back unproved, including the
 * healthy one whose entire job is to come back `yes` — and a suite where the negative control
 * fails is a suite that cannot tell a careful implementation from a mute one.
 *
 * That is the specification's own ordering, stated in its own words -- a claim is registered
 * before the action and a window is opened to hold what follows -- and it was violated by the
 * binding written to demonstrate it. Which is the argument for running your own suite: the rule
 * was written down, agreed with, and broken in the same week by the person who wrote it.
 */

/** How long a scenario's window is given before it is judged on what it saw. */
const WINDOW_BUDGET_MS = 8_000;

/**
 * Evidence from what the realm observed, at the grades its own channel declaration assigns.
 *
 * Built here rather than by the realm, because a realm that produced evidence would be grading
 * the weight of its own observations — the separation the specification exists to keep.
 */
/**
 * An observation that records a send and can never record its outcome.
 *
 * A one-way dispatch is the clearest case and the one that produced a false green: the caller
 * gets no reply by construction, so no later event can tell anybody whether the effect happened.
 * `presence` is exactly what that is worth -- something was there -- and the whole point of the
 * grade is that presence may not buy a `yes`.
 *
 * Deliberately narrow. A request still IN FLIGHT is not included: it may settle inside the window
 * and its settled event carries the outcome, so downgrading it would discard evidence the
 * verifier is about to be given. That case is already handled, and handled in the right place --
 * as a `still-in-flight` blind spot in coverage, which says "I stopped watching" rather than
 * "this proves nothing".
 */
function provesOnlyDispatch(observation: { readonly value?: unknown }): boolean {
  const value = observation.value;
  if ('object' !== typeof value || null === value) return false;
  return true === (value as { oneWay?: unknown }).oneWay;
}

/**
 * How this window actually closed, rather than how it hoped to.
 *
 * The binding used to report `closedBy: window.closes` -- the condition the window was OPENED
 * with -- so `closedCleanly` was true by construction and clause 5 could never fire. A field
 * always set to the happy value is the same defect as `impeaching`, which made clause 6
 * unreachable: defined, deferred to somebody, and decided by nobody.
 *
 * The honest answer available here is the budget. If the window was still open when its budget
 * ran out, the verifier stopped watching, and that is `budget-exhausted` whatever the window was
 * waiting for. Quiescence itself is the realm's to measure; this is the part the binding knows.
 */
function closedBy(
  window: { readonly openedAt: number; readonly budgetMs: number; readonly closes: CloseCondition },
  closedAt: number,
  settleUnmeasurable: boolean,
): CloseCondition {
  // A throttled page is the case the specification singles out: *"'the verifier gave up' and
  // 'this realm cannot measure the close condition' are different facts, and an implementation
  // MUST NOT report the second as the first."* A hidden tab never flushes the frame quiescence
  // is read from, and it is the NORMAL state for agent-driven verification, so reporting
  // budget-exhausted here would make every backgrounded subject permanently unprovable at
  // clause 5.
  //
  // The gap is reported instead as a non-impeaching `time` blind spot by the realm, which costs
  // a claim nothing unless it reads `time`. This line is what stops the budget derivation
  // overriding that.
  if (settleUnmeasurable) return window.closes;
  return closedAt - window.openedAt >= window.budgetMs
    ? CloseCondition.BUDGET_EXHAUSTED
    : window.closes;
}

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
      // The channel's grade is a CEILING, not every observation's grade. Taking it unconditionally
      // is how `fire-and-forget` came back `yes`: a one-way `ipcRenderer.send` travels on `net`,
      // `net` is declared consequence-grade, and so "something was dispatched and can never
      // report an outcome" was counted as proof that the outcome happened.
      //
      // Reticle already knew better -- the desktop battery asserts that a one-way call is
      // "reported as one-way with NO status", precisely because dispatched is not succeeded --
      // and that knowledge stopped at the observer. This is the adapter's job: the specification
      // supplies the two grades, and which one an observation deserves is a realm's judgement.
      grade: provesOnlyDispatch(observation) ? Grade.PRESENCE : channel.grade,
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
  /** The window the last action was performed inside, handed to the next `verify`. */
  let open: ReturnType<WebRealm['openWindow']> | undefined;
  return {
    async hello() {
      // `describe` is REQUIRED by the interface and was called by nothing in this binding, so an
      // implementation could have thrown from it and still earned a profile. It is exercised
      // here rather than in a scenario because it is not a claim about an application: it is the
      // question "can this implementation read its own subject at all", which belongs with the
      // other two handshake answers.
      //
      // A failure refuses the run instead of scoring it. That is deliberately unlike a plant we
      // cannot apply, which is ABSENT: ABSENT means *we* could not ask, and this means the
      // implementation does not answer something the interface obliges it to.
      let described: unknown;
      try {
        described = await realm.describe();
      } catch (error) {
        throw new Error(
          `the implementation's describe() threw, and the interface requires it: ${String(error)}`,
        );
      }
      if (described === undefined) {
        throw new Error("the implementation's describe() answered nothing, and it is required");
      }
      // Both answers below are already declared; the interface is async for an implementation
      // that has to go and ask.
      return {
        channels: realm.channels().map((c) => c.id),
        commands: realm.capabilities().map((c) => c.name),
      };
    },

    locate(query) {
      // A read, so it returns data. It cannot go through `command`, which reports a receipt and
      // never results -- the separation that stops an action reporting whether it worked.
      return realm.locate === undefined ? Promise.resolve([]) : realm.locate(query);
    },

    async command(name, args = {}) {
      // Opened before the action, not after it. See the note above.
      //
      // The budget is the subject's to shorten. One scenario needs a window that runs out before
      // the application settles -- the verifier giving up, which must never be read as the
      // application failing -- and there is no way to produce that without asking for less time
      // than the work takes.
      const budget = 'number' === typeof args['budgetMs'] ? args['budgetMs'] : WINDOW_BUDGET_MS;
      open = realm.openWindow(budget);
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
      // The window opened by `command`, holding what the action caused. Falling back to a fresh
      // one keeps a caller that verifies without acting honest rather than crashing -- it will
      // observe nothing and be told so.
      const window = open ?? realm.openWindow(WINDOW_BUDGET_MS);
      open = undefined;
      const closedAt = now();
      const observations = await realm.observe(window);
      const coverage: Coverage = await realm.coverage(window);
      const decided = adjudicate({
        claim: { ...claim, declaredAt: claim.declaredAt ?? Declaration.BEFORE_ACTION },
        window: {
          ...window,
          closedAt: closedAt,
          closedBy: closedBy(window, closedAt, realm.settleWasThrottled()),
        },
        channels: realm.channels(),
        evidence: asEvidence(realm, observations, now()),
        coverage,
        // Asked for, at last. The binding passed an empty array for as long as the interface
        // had no way to return one, and three planted defects came back `yes` because of it.
        anomalies: realm.detect === undefined ? [] : await realm.detect(window, observations),
        // The specification evaluates its own predicate forms, so this is a real answer now
        // rather than a shrug. Still three-valued: a claim written in a language the
        // specification does not speak comes back `undefined`, which means nobody evaluated it
        // and must never be read as either pass or fail.
        assertionsHeld: assertionsHeld(claim.assertions, observations),
        // NOT supplied, and deliberately left `undefined` rather than `false`. The
        // specification reads `undefined` here as NOBODY CHECKED and `false` as "checked, and
        // it did not already hold" -- so passing `false` to fill the field would be a lie that
        // scores better, which is the one thing a conformance client must never do.
        //
        // It is not supplied because this client cannot answer it: the window opens at
        // `command` and the claim only arrives here at `verify`, so at the moment the
        // before-state could be read there is nothing yet to evaluate against. Answering it
        // needs the claim declared before the action, which the protocol already has a word
        // for (`Declaration.BEFORE_ACTION`) and this binding does not yet act on.
        //
        // The cost is exact and worth writing down: clause 10 (`already-true`) is the one
        // adjudication clause no run of this suite can reach. Pinned in
        // conformance/subjects/coverage.test.mjs so closing this gap deletes a line there.
      });
      return {
        verdict: decided.verdict,
        ground: decided.ground,
        ...(decided.reasons[0] === undefined ? {} : { reason: decided.reasons[0] }),
      };
    },
  };
}
