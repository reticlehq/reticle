/**
 * Breaking a driven page on purpose, with machinery that already exists.
 *
 * A flow that would stay green if the feature broke is a false green with a maintenance cost, and
 * the only way to find one is to break the thing it claims to watch. `setMocks` already fails a
 * request on a driven page and clearing the rules already puts it back, which makes this a real
 * mutation with a real reversal rather than a new capability nobody has proved.
 *
 * A failing request is the sharpest single mutation available here. A flow whose action fires a
 * request that 500s and still passes is one that never asserted the consequence — precisely the
 * shape the demotion grade exists to catch.
 */

import { MutationKind, type Reversal } from '@reticlehq/openreality';
import type { MockRule } from './network-mock.js';
import type { RealInputProvider } from './real-input.js';

/**
 * How a broken endpoint breaks: the request ABORTS. It leaves and never arrives.
 *
 * This used to fulfill with a fabricated 500 — a response the server never sent. Grading a flow
 * against an invented payload grades it against Reticle's fiction, and the grade is a real
 * accusation ("this is a click sequence, not a test") to make on made-up input. A verdict built on
 * something nobody observed is the exact failure this product exists to catch.
 *
 * An abort is a real failure mode — server down, network partition, DNS gone — and nothing is
 * claimed on the server's behalf. It is also the STRICTLY harder break to survive silently: an app
 * can quietly read a 500 body as empty data and carry on looking fine, but no code path mistakes a
 * request that never completed for a successful one. A flow that stays green through it is
 * unambiguously not checking what it declared it depends on.
 */

/**
 * What this hands back. Declared here rather than imported from the realm that consumes it: the
 * realm owns the interface it depends on and this file owns a thing that provides one, and a
 * provider that imported its consumer would be the inversion backwards.
 */
export interface NetworkMutationPort {
  mutate(mutation: { kind: string; target?: string }): Promise<Reversal>;
  revert(): Promise<void>;
}

/**
 * A port for this session, or nothing.
 *
 * Nothing when the provider cannot install mocks, and nothing when it is not driving THIS page —
 * breaking a page this provider does not drive would perturb somebody else's subject.
 */
export async function mutationPortFor(
  provider: RealInputProvider,
  sessionUrl: string,
): Promise<NetworkMutationPort | undefined> {
  if (provider.setMocks === undefined) return undefined;
  if (!(await provider.isAvailableFor(sessionUrl))) return undefined;
  const setMocks = (rules: MockRule[]): Promise<boolean> =>
    provider.setMocks?.(sessionUrl, rules) ?? Promise.resolve(false);
  return {
    async mutate(mutation): Promise<Reversal> {
      /*
       * A kind this page cannot perform is REFUSED, never faked.
       *
       * The mutation set is allowed to be small — a realm perturbs what it has. What it may not do
       * is report a perturbation it never applied, because a flow would then be demoted for
       * surviving something that never happened to it. That is the mutation score lying in the
       * direction that looks like rigour.
       */
      if (MutationKind.REQUEST_FAILS !== mutation.kind) {
        throw new Error(
          `a driven web page cannot perform the mutation "${mutation.kind}" — it breaks requests, ` +
            `and nothing else. Refusing rather than reporting a break that did not happen: a flow ` +
            `that survived a mutation nobody applied would be demoted for somebody else's gap.`,
        );
      }
      if (mutation.target === undefined || '' === mutation.target) {
        throw new Error(
          'a failing-request mutation needs a `target` — the URL fragment to break (e.g. ' +
            '"/api/orders"). Failing every request would not test a flow, it would unplug the app.',
        );
      }
      await setMocks([{ urlContains: mutation.target, abort: true }]);
      return { mutation: `${MutationKind.REQUEST_FAILS}:${mutation.target}` };
    },
    /** Clearing the rules is the undo. A break nobody reverses is damage the next run inherits. */
    async revert(): Promise<void> {
      await setMocks([]);
    },
  };
}
