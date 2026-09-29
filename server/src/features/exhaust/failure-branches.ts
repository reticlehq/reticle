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

import { isAbsenceDerived, isAdvisory } from '@reticlehq/core';
import { findContradictions } from '@reticlehq/engine/disagreement/contradictions.js';
import {
  controlsOf,
  replayPath,
  stateKey,
  type ExplorePort,
  type ExploredWrite,
} from './explorer.js';

export interface FailureBranches {
  branched: string[];
  unhandled: { key: string; detail: string }[];
  /** Why nothing was driven, when nothing could be. */
  skipped?: string;
}

const NO_MOCKS =
  'failure paths need a driven browser to break a request in (`reticle drive`, or RETICLE_CDP_URL); none were driven, so none were proved';

export async function driveFailureBranches(
  port: ExplorePort,
  writes: readonly ExploredWrite[],
  opts: { maxActions: number },
): Promise<FailureBranches> {
  const out: FailureBranches = { branched: [], unhandled: [] };
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
    if (!(await mock([{ urlContains: write.urlPath, method: write.method, abort: true }])))
      return { ...out, skipped: NO_MOCKS };
    try {
      // Everything up to the step that fires the write, then that step with the write failing.
      if (!(await replayPath(port, write.path.slice(0, -1), act, spent))) continue;
      const control = controlsOf((await port.look()).tree).find((c) => c.key === last.key);
      if (control === undefined) continue;
      const result = await act(control.ref, last.action, last.value);
      out.branched.push(write.key);
      const after = await port.look();
      const reached = stateKey(after.route, controlsOf(after.tree));
      const contradiction = findContradictions([...result.events], { actionSince: 0 }).find(
        (c) => !isAdvisory(c.kind) && !isAbsenceDerived(c.kind),
      );
      if (reached === write.successState)
        out.unhandled.push({
          key: write.key,
          detail: `with ${write.key} failing, the app arrived exactly where it goes when the write succeeds (${after.route ?? 'same page'}) — it claimed success over a failure`,
        });
      else if (contradiction !== undefined)
        out.unhandled.push({
          key: write.key,
          detail: `${contradiction.claim}, but ${contradiction.counter}`,
        });
    } finally {
      await mock([]);
    }
  }
  return out;
}
