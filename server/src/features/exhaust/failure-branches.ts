/**
 * The `branched` level: every write the explorer found, driven down its FAILURE path.
 *
 * The happy path is the one every drive already takes. What a user meets when the server is down is
 * the one nobody checks, and it is where "the toast said Saved" over a lost write lives.
 *
 * The break is an ABORT, not a fabricated 500 — see portal/input/network-mutation.ts: an app can read
 * a 500 body as empty data and look fine, but no code path mistakes a request that never completed
 * for a successful one.
 *
 * The oracle needs nothing app-specific: with the write failing, the app must NOT arrive at the state
 * it reaches when the write succeeds. Arriving there is claiming success over a failure. A
 * contradiction the engine observes in the window counts too.
 */

import {
  EventType,
  asNumber,
  isAbsenceDerived,
  isAdvisory,
  type ReticleEvent,
} from '@reticlehq/core';
import { findContradictions } from '@reticlehq/engine/disagreement/contradictions.js';
import {
  controlsOf,
  replayPath,
  stateKey,
  type ExplorePort,
  type ExploredWrite,
} from './explorer.js';
import { writeKeyOf } from './session-fold.js';

export interface FailureBranches {
  branched: string[];
  unhandled: { key: string; detail: string }[];
  /**
   * Writes whose success changed nothing the explorer can see, so success and failure look the same
   * and nothing can be concluded from where the app landed. Not a finding — a blind spot to check
   * by hand, or to give the app a visible outcome.
   */
  indistinguishable: string[];
  /** Why nothing was driven, when nothing could be. */
  skipped?: string;
}

const NO_MOCKS =
  'failure paths need a driven browser to break a request in (`reticle drive`, or RETICLE_CDP_URL); none were driven, so none were proved';

/** The target write, sent and never answered: an aborted request reports status 0. */
function aborted(e: ReticleEvent, key: string): boolean {
  return (
    EventType.NET_REQUEST === e.type &&
    writeKeyOf(e) === key &&
    (0 === asNumber(e.data['status']) || e.data['error'] !== undefined)
  );
}

export async function driveFailureBranches(
  port: ExplorePort,
  writes: readonly ExploredWrite[],
  opts: { maxActions: number },
): Promise<FailureBranches> {
  const out: FailureBranches = { branched: [], unhandled: [], indistinguishable: [] };
  const mock = port.mock;
  if (mock === undefined) return { ...out, ...(0 < writes.length ? { skipped: NO_MOCKS } : {}) };
  let actions = 0;
  const spent = (): boolean => actions >= opts.maxActions;
  const act = (ref: string, action: 'click' | 'fill', value?: string) => {
    actions += 1;
    return port.act(ref, action, value);
  };
  for (const write of writes) {
    if (spent()) break;
    const last = write.path.at(-1);
    if (last === undefined) continue;
    try {
      // Everything up to the step that fires the write, THEN the break. Installed before the replay,
      // the abort also broke any setup step sending the same request, and the replay died short of
      // the action it existed to reach.
      if (!(await replayPath(port, write.path.slice(0, -1), act, spent))) continue;
      if (!(await mock([{ urlContains: write.urlPath, method: write.method, abort: true }])))
        return { ...out, skipped: NO_MOCKS };
      const control = controlsOf((await port.look()).tree).find((c) => c.key === last.key);
      if (control === undefined) continue;
      const result = await act(control.ref, last.action, last.value);
      // Driven means the write was SENT and did not complete. An action that never dispatched, or a
      // request the rule did not match, drove nothing — and judging where the app landed after a
      // write that succeeded would accuse it of claiming success over a failure that never happened.
      if (!result.ok || !result.events.some((e) => aborted(e, write.key))) continue;
      out.branched.push(write.key);
      const after = await port.look();
      const reached = stateKey(after.route, controlsOf(after.tree));
      // The failure is OURS, so it is declared. Without that, the engine's "UI moved beside a failed
      // request" rule cannot tell an app that swallowed the error from one that correctly RENDERED
      // it, and every well-behaved error message read as a finding. A success signal fired over the
      // failure still contradicts. Found by driving the fixture.
      const contradiction = findContradictions([...result.events], {
        actionSince: 0,
        expectedFailures: [{ method: write.method, urlContains: write.urlPath }],
      }).find((c) => !isAdvisory(c.kind) && !isAbsenceDerived(c.kind));
      if (contradiction !== undefined)
        out.unhandled.push({
          key: write.key,
          detail: `${contradiction.claim}, but ${contradiction.counter}`,
        });
      // Landing where success lands only ACCUSES when success visibly moved the app. A write whose
      // success shows nothing looks identical failing, and the first version of this called that
      // "claimed success" — found by driving the fixture, whose add-item panel claims nothing at all.
      else if (write.successState === write.beforeState) out.indistinguishable.push(write.key);
      else if (reached === write.successState)
        out.unhandled.push({
          key: write.key,
          detail: `with ${write.key} failing, the app arrived exactly where it goes when the write succeeds (${after.route ?? 'same page'}) — it claimed success over a failure`,
        });
    } finally {
      await mock([]);
    }
  }
  return out;
}
