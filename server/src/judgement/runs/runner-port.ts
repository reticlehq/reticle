/**
 * The live adapter: build a RunnerPort from the real ToolDeps so ReticleRunner drives actual flow
 * replays against the connected app. Thin glue — it wires the session's flow list, replayNamedFlow, deps.now,
 * and a uuid generator. The ReticleRunner core (tested with a fake port) holds all the orchestration and
 * verdict logic, so this layer carries no decisions.
 */

import { ReplayStatus, type FlowReplayResult } from '@reticlehq/core';
import { replayAndLearn } from '@/language/flows/flow-learning.js';
import { sessionUrlOf } from '@/language/flows/flow-lease.js';
import { START_PATH_ARRIVAL_TIMEOUT_MS, startPathBudgetMs } from '@/language/flows/flow-journey.js';
import { flowStartState } from '@/surface/tools/session-ports.js';
import { flowsForSession } from '@/language/flows/flow-store-for-session.js';
import { safeSessionTarget } from '@/memory/project/session-root.js';
import { resolveSessionWithin } from '@/portal/session/timing/resolve-within.js';
import { WALL_CLOCK } from '@/portal/session/timing/wall-clock.js';
import type { DrivenPage } from '@/portal/input/driven-page.js';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';
import type { RunnerPort, SessionLoss } from './reticle-runner.js';
import { defaultRunId } from './default-run-id.js';
export { defaultRunId } from './default-run-id.js';

/**
 * The tab that one run drives (#2060).
 *
 * Without it, a run with no `--session-id` let each replay choose a tab, and a check after a flow
 * counted any connected tab. With the user's own tab of the app open, the driven page went to a
 * page with no SDK, the user's tab still counted as a session, and the later flows clicked in the
 * user's tab and passed. The driven page stayed on the dead page.
 */
interface Pin {
  /** The session id that every replay of the run gets. */
  id: string;
  /**
   * True when `id` is the driven page's own session, read from the page. Then only that id counts.
   * A successor is not accepted. The successor rule leaves out the tabs that were open before the
   * driven tab left, but it can choose a tab that connects after that: the user's tab of the same
   * app, opened while the driven page is on a page with no SDK. The driven tab keeps its id when
   * it connects again, so it never needs a successor.
   */
  driven: boolean;
}

/** A flow that the run did not replay, because the page that it drives has no session. */
export function drivenPageNoSessionReason(id: string): string {
  return (
    `the page that this run drives has no session: its tab (session '${id}') did not connect in ` +
    'the time that a replay waits for its start page. The run does not replay this flow in ' +
    'another tab.'
  );
}

/** Said to `resolveSessionWithin` while the run's tab is not connected. Never shown to a reader. */
const TAB_NOT_CONNECTED = 'the tab that the run drives is not connected';

/**
 * How often the check after a flow reads the driven page again while it waits. The same cadence
 * as `resolveSessionWithin`. It sets how often to look, not how long: the start-page budget does.
 */
const PAGE_POLL_MS = 250;

/**
 * Throw the daemon's no-session diagnosis (the port scan, the next action), as a replay with no
 * tab connected throws it. An id-less `resolve()` throws it when no tab is connected.
 */
function throwNoSessionDiagnosis(deps: ToolDeps): void {
  if (0 === deps.sessions.count()) {
    deps.sessions.resolve();
  }
}

/** Wire a RunnerPort to the live session. Pass sessionId to disambiguate when several tabs are open. */
export function createRunnerPort(
  deps: ToolDeps,
  sessionId?: string,
  opts: {
    /** `reticle verify --confirm-dangerous`: this run acknowledges the steps held as destructive. */
    confirmDangerous?: boolean;
    requireStartControl?: boolean;
    sweep?: boolean;
    /** Injected so a test moves its own clock while the port waits for a session. */
    sleep?: (ms: number) => Promise<void>;
  } = {},
): RunnerPort {
  const sleep = opts.sleep ?? WALL_CLOCK.sleep;
  // Per run: startRun clears both. Two HTTP /verify runs at the same time on one port share them,
  // as they share the one driven page; the runner is sequential within a run, not across runs.
  let pin: Pin | undefined;
  let lastFlow: string | undefined;
  // Was the run's tab connected when the last flow started? A tab that was never connected was not
  // lost: then the replay's own reason (the daemon's diagnosis) is the true one.
  let connectedAtStart = false;
  const drivenPage = (): DrivenPage | undefined => deps.realInput?.drivenPage?.();

  /**
   * Choose the tab of the run. An explicit sessionId comes first. Then the driven page's own
   * session. With no driven page, the only connected tab of the project. With several tabs and no
   * driven page, nothing is chosen, and each replay chooses as before.
   */
  const pinTab = async (): Promise<void> => {
    const page = drivenPage();
    const own = await page?.sessionId();
    if (sessionId !== undefined) {
      pin = { id: sessionId, driven: own === sessionId };
      return;
    }
    if (own !== undefined) {
      pin = { id: own, driven: true };
      return;
    }
    const [only, second] = deps.sessions.inScope();
    if (page === undefined && only !== undefined && second === undefined) {
      pin = { id: only.id, driven: false };
    }
  };

  /** The driven page can register under a new id. The id in the page is the one that counts. */
  const refreshPin = async (): Promise<void> => {
    if (pin?.driven !== true) {
      return;
    }
    const own = await drivenPage()?.sessionId();
    if (own !== undefined) {
      pin = { id: own, driven: true };
    }
  };

  /**
   * Is the run's tab connected? A read-only check: resolve() marks agent activity, and with no
   * sessionId it also refuses when several tabs are connected. Neither is a lost session.
   */
  const connected = (): boolean => {
    if (pin === undefined) {
      return 0 < deps.sessions.inScope().length;
    }
    if (deps.sessions.get(pin.id) !== undefined) {
      return true;
    }
    return !pin.driven && deps.sessions.successorId(pin.id) !== undefined;
  };

  /**
   * The wait that replay gives a start page (#2168), for the flow `name`. The floor of that wait
   * when the flow cannot be loaded. Found in the store that listFlows reads: the run's tab can be
   * the one that is not connected.
   */
  const startBudget = async (name: string): Promise<number> => {
    const target = safeSessionTarget(deps, sessionId);
    const loaded = await flowsForSession(deps, target)
      .flows.load(name, target.projectId)
      .catch(() => undefined);
    return true === loaded?.ok ? startPathBudgetMs(loaded.value) : START_PATH_ARRIVAL_TIMEOUT_MS;
  };

  /** Wait for the run's tab as replay waits for a start page. True when it is connected. */
  const waitForTab = async (name: string): Promise<boolean> => {
    if (connected()) {
      return true;
    }
    const view = {
      resolve: (): true => {
        if (!connected()) {
          throw new Error(TAB_NOT_CONNECTED);
        }
        return true;
      },
      count: () => (connected() ? 1 : 0),
    };
    return resolveSessionWithin(view, undefined, await startBudget(name), {
      now: deps.now,
      sleep,
    }).then(
      () => true,
      () => false,
    );
  };

  /**
   * Before a replay, wait for the tab that the run chose. A replay with the id of a tab that is
   * not connected does not wait while another tab is, so the wait is here. With no tab connected
   * at all, the daemon's no-session diagnosis is thrown, as the replay threw it before. With
   * another tab connected, a driven page's flow is not replayed: it would run in the other tab.
   * An explicit sessionId keeps the replay's own rules. Undefined: the replay can go on.
   */
  const beforeReplay = async (name: string): Promise<FlowReplayResult | undefined> => {
    if (pin === undefined || sessionId !== undefined || (await waitForTab(name))) {
      return undefined;
    }
    throwNoSessionDiagnosis(deps);
    if (!pin.driven) {
      return undefined;
    }
    return {
      name,
      status: ReplayStatus.UNVERIFIABLE,
      steps: [],
      unverifiable: { reason: drivenPageNoSessionReason(pin.id) },
    };
  };

  /** Was the run's tab connected when the flow started, or has it left (its tombstone)? */
  const everConnected = (): boolean =>
    connectedAtStart || (pin !== undefined && deps.sessions.departed(pin.id) !== undefined);

  /**
   * The check after a flow for a run with no driven page to read: a tab of `--session-id`, the only
   * tab of an HTTP run, or no pinned tab. Lost only when the tab was connected when the flow
   * started, or has left (its tombstone), and did not connect again in the start-page wait.
   */
  const otherTabLost = async (): Promise<SessionLoss | undefined> => {
    if (connected()) {
      return undefined;
    }
    if (!everConnected()) {
      return undefined;
    }
    if (lastFlow !== undefined && (await waitForTab(lastFlow))) {
      return undefined;
    }
    return lossAt(undefined);
  };

  /** The URL where the run's tab was lost: the driven page's URL, or where the tab was heading. */
  const lossAt = (page: DrivenPage | undefined): SessionLoss => {
    const lastUrl =
      page?.url() ?? (pin === undefined ? undefined : deps.sessions.departed(pin.id)?.departedTo);
    return lastUrl === undefined || 0 === lastUrl.length ? {} : { lastUrl };
  };

  // Each flow starts from the state the run started in, so one that signs out cannot fail the rest.
  const startState = flowStartState(deps.realInput, () => sessionUrlOf(deps, pin?.id ?? sessionId));
  return {
    startRun: () => {
      pin = undefined;
      lastFlow = undefined;
    },
    // Resolved as replay resolves it, so every listed name is one replay can load.
    listFlows: () => {
      const target = safeSessionTarget(deps, sessionId);
      return flowsForSession(deps, target).flows.list(target.projectId);
    },
    replayFlow: async (name) => {
      lastFlow = name;
      if (pin === undefined) {
        await pinTab();
      } else {
        await refreshPin();
      }
      // Set before the wait, which can throw: the value of the last flow must not stay.
      connectedAtStart = false;
      const refused = await beforeReplay(name);
      connectedAtStart = connected();
      if (refused !== undefined) {
        return refused;
      }
      const cannotStart = await startState();
      if (cannotStart !== undefined) {
        return {
          name,
          status: ReplayStatus.UNVERIFIABLE,
          steps: [],
          unverifiable: { reason: cannotStart },
        };
      }
      return await replayAndLearn(deps, {
        flowName: name,
        ...(pin === undefined ? {} : { sessionId: pin.id }),
        ...(true === opts.confirmDangerous ? { confirmDangerous: true } : {}),
        ...(true === opts.requireStartControl ? { requireStartControl: true } : {}),
        ...(true === opts.sweep ? { sweep: true } : {}),
      });
    },
    /*
     * A tab that was not connected when the flow started, and never connected before, was not
     * lost: the replay's own reason is the true one. Otherwise, for the driven page, the page in
     * the tab answers, not the socket map. When the last step loads a page with no SDK, the check
     * runs before the old document's socket has closed, so the pin still looks connected. A
     * connected session counts only while the page in the tab has the SDK global. A dead end
     * (DrivenPage.deadEnd) is reported at once. Any other page gets the start-page wait, which
     * ends as soon as the page has the SDK and its session is connected. A page that has the SDK
     * but did not connect is not reported as lost: it did not leave the app.
     */
    sessionLost: async () => {
      await refreshPin();
      const page = true === pin?.driven ? drivenPage() : undefined;
      if (page === undefined) {
        return otherTabLost();
      }
      if (!everConnected()) {
        return undefined;
      }
      const deadline = deps.now() + (lastFlow === undefined ? 0 : await startBudget(lastFlow));
      for (;;) {
        const sdk = await page.hasSdk();
        if (true === sdk && connected()) {
          return undefined;
        }
        if (await page.deadEnd()) {
          return lossAt(page);
        }
        const remaining = deadline - deps.now();
        if (remaining <= 0) {
          return true === sdk ? undefined : lossAt(page);
        }
        await sleep(Math.min(PAGE_POLL_MS, remaining));
      }
    },
    // No wait: before each later flow, is the tab back, or does the driven page have the SDK again?
    sessionBack: async () => {
      await refreshPin();
      if (connected()) {
        return true;
      }
      return true === pin?.driven && true === (await drivenPage()?.hasSdk());
    },
    // Only the page load, and only of the page that lost its session. The next replay waits.
    reopen: async () => {
      const page = true === pin?.driven ? drivenPage() : undefined;
      return page === undefined ? false : await page.reopen();
    },
    now: () => deps.now(),
    newRunId: defaultRunId,
  };
}
