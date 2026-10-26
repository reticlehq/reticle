/**
 * Provider capabilities handed to features as ports: a suite fixture to seed from, save/restore,
 * slowing the page and breaking it. Each is `undefined` when the provider cannot do it. They sit on
 * the tool side because a feature reaching into the input layer directly would depend on a driver.
 */
import type { RealInputProvider } from '@/portal/input/real-input.js';
import {
  fixturePortFor,
  seedFromStorageState,
  type StorageFixturePort,
} from '@/portal/input/storage-fixture.js';
import { mutationPortFor, type NetworkMutationPort } from '@/portal/input/network-mutation.js';
import type { Perturbation, SeedStorage } from '@reticlehq/core';

/**
 * The state a suite should boot its flows from: whatever the agent is already sitting in.
 *
 * This is the join the fixture work was building toward. A suite's flows each start from cold, so
 * fifty of them prove the login works fifty times — and the flow that LOGS OUT leaves every flow
 * after it signed out, which no navigation repairs, because the problem is not where the subject is
 * but what it holds. A seed is applied to an isolated context BEFORE the first navigation, which is
 * exactly and only when a fixture can work.
 *
 * Best-effort, deliberately. A fixture is an OPTIMISATION over running from cold, and running from
 * cold is correct: a suite that refused to start because a cookie jar could not be read would have
 * traded a slow answer for no answer. Every "no" here — no provider, no storage support, nothing
 * driven, a browser that threw, nothing worth seeding — produces the same honest `undefined`, and
 * the suite runs exactly as it did before any of this existed.
 */
export async function suiteFixtureSeed(
  realInput: RealInputProvider | undefined,
  appUrl: string,
): Promise<SeedStorage | undefined> {
  if (realInput === undefined) {
    return undefined;
  }
  try {
    const port = await fixturePortFor(realInput, appUrl);
    if (port === undefined) {
      return undefined;
    }
    return seedFromStorageState(await port.capture(), appUrl);
  } catch {
    return undefined;
  }
}

/**
 * A way to make this session's page SLOW on purpose, or nothing.
 *
 * The third of these seams, for the same reason as the other two: a feature reaching into the input
 * layer directly is a feature depending on a driver, and the boundary guard asks about it.
 *
 * Installs delays and NOTHING else. A rule that carried a status or a body would substitute a
 * response the server never sent, and an app raced against invented data produces invented races —
 * a fabricated defect handed to somebody at 3am, which is worse than finding nothing.
 */
export async function sessionPerturbationPort(
  realInput: RealInputProvider | undefined,
  appUrl: string | undefined,
): Promise<
  { slow(rules: readonly Perturbation[]): Promise<void>; clear(): Promise<void> } | undefined
> {
  if (realInput === undefined || appUrl === undefined) {
    return undefined;
  }
  const setMocks = realInput.setMocks?.bind(realInput);
  if (setMocks === undefined) {
    return undefined;
  }
  if (!(await realInput.isAvailableFor(appUrl))) {
    return undefined;
  }
  return {
    slow: async (rules) => {
      await setMocks(appUrl, [...rules]);
    },
    /** Clearing is the undo. A page left slowed is damage the next run inherits. */
    clear: async () => {
      await setMocks(appUrl, []);
    },
  };
}

/**
 * Save/restore for this session's page, or nothing.
 *
 * The same job as `suiteFixtureSeed` next door, stopping one step earlier: that one captures and
 * converts, this hands back the PORT so a caller can re-apply what it captured later. It lives here
 * for the reason written above — a feature reaching into the input layer directly is a feature
 * depending on a driver, and the boundary guard asks about it. It asked.
 */
export async function suiteFixturePort(
  realInput: RealInputProvider | undefined,
  appUrl: string | undefined,
): Promise<StorageFixturePort | undefined> {
  if (realInput === undefined || appUrl === undefined) {
    return undefined;
  }
  try {
    return await fixturePortFor(realInput, appUrl);
  } catch {
    return undefined;
  }
}

/**
 * A way to break this session's page, or nothing.
 *
 * Sits beside `suiteFixtureSeed` because it is the same shape of job: turning a provider capability
 * into something a feature can use, on the one side of the graph that is allowed to know about both.
 * A flow tool reaching into the input layer directly would be a feature depending on a driver, which
 * is the reach the boundary guard exists to ask about.
 */
export async function sessionMutationPort(
  realInput: RealInputProvider | undefined,
  appUrl: string | undefined,
): Promise<NetworkMutationPort | undefined> {
  if (realInput === undefined || appUrl === undefined) {
    return undefined;
  }
  try {
    return await mutationPortFor(realInput, appUrl);
  } catch {
    // A provider that cannot answer is the same answer as a provider that cannot break anything.
    return undefined;
  }
}
