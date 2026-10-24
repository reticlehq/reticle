import { carryReticleIdentity } from './lease-tools.js';
import { z } from 'zod';
import { navigateResult } from './act/navigation/navigate-result.js';
import {
  absoluteTarget,
  awaitArrival,
  idsOpenAtDispatch,
  ARRIVAL_TIMEOUT_MS,
} from './act/navigation/navigate-arrival.js';
import { reloadResult } from './act/navigation/reload-result.js';
import {
  waitForReconnect,
  RELOAD_RECONNECT_TIMEOUT_MS,
} from '@/portal/session/session-reconnect.js';
import { ReticleCommand } from '@reticlehq/core';
import { ReticleTool } from '@reticlehq/core';
import { asNumber, asString } from '@reticlehq/core';
import { sessionIdShape, commandOrThrow } from './tool-kit.js';
import { timeoutMsSchema } from './args/numeric-bounds.js';
import { assertNotPaymentNavigation } from './act/act-danger.js';
import type { ToolDef, ToolDeps } from './tool-kit.js';

/** Said when a lease's page now has no Reticle SDK: only the browser can still act on it. */
const MSG_LEASE_WITHOUT_SDK =
  'This page has no Reticle SDK, so only browser-level actions apply here (navigate, screenshot). ' +
  'The lease is kept: navigate back to the app and it reattaches.';

/** Navigate a lease through its browser page, and wait for its SDK to come back. */
async function navigateLease(
  deps: ToolDeps,
  sessionId: string,
  url: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const timeoutMs = asNumber(args['timeout_ms']) ?? ARRIVAL_TIMEOUT_MS;
  const went = (await deps.pool?.gotoLease(sessionId, url, timeoutMs)) ?? false;
  if (!went) return { ok: false, url, reason: 'the leased page did not navigate' };
  const back = await waitForSession(deps, sessionId, timeoutMs);
  return back
    ? { ok: true, url, confirmed: true, sessionId }
    : { ok: true, url, confirmed: false, waitedMs: timeoutMs, note: MSG_LEASE_WITHOUT_SDK };
}

/** Whether the session reconnects within the budget. */
async function waitForSession(
  deps: ToolDeps,
  sessionId: string,
  timeoutMs: number,
): Promise<boolean> {
  const start = deps.now();
  for (;;) {
    if (deps.sessions.get(sessionId) !== undefined) return true;
    if (deps.now() - start >= timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, LEASE_POLL_MS));
  }
}

const LEASE_POLL_MS = 100;

export const BROWSER_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.NAVIGATE,
    example: { url: '/settings' },
    description:
      'Navigate the connected browser tab to a URL, or reload it in place with { reload: true } (add { hard: true } to bypass the cache). `ok` means the navigation was DISPATCHED — the SDK is torn down by the navigation, so the old page cannot report on it. The daemon then waits up to `timeout_ms` (default 5000) for the SDK to reconnect. `confirmed:true` with a `sessionId` means the requested page arrived and you can act immediately. `confirmed:false` with `landedOn` means the navigation arrived but the app landed at another URL, such as an authentication or route-guard redirect; use `landedOn` to understand where the browser actually ended up. `confirmed:false` without `landedOn` means the target was not observed within the wait window; a slow app may still be on its way, so increase `timeout_ms` when appropriate.',
    inputSchema: {
      url: z.string().optional().describe('The URL to navigate to. Omit when using reload.'),
      reload: z
        .boolean()
        .optional()
        .describe(
          'Reload the current page instead of navigating (replaces the former standalone refresh tool).',
        ),
      hard: z
        .boolean()
        .optional()
        .describe('With reload:true, bypass the browser cache (Cmd+Shift+R). Default: false.'),
      timeout_ms: timeoutMsSchema
        .optional()
        .describe(
          'How long to wait for the page to come back (the SDK reconnecting at the new URL, or under the same id on a reload) before answering confirmed:false. Default 5000. 0 looks once without waiting. An SPA reattaching under HMR has been measured at 30-60s — say so here instead of polling reticle_sessions.',
        ),
      ...sessionIdShape,
    },
    outputSchema: {
      ok: z.boolean(),
      url: z.string().optional(),
      reason: z.string().optional(),
      // Present on a dispatched navigation: nothing here can see the new document, so arrival is
      // reported as unconfirmed rather than implied by `ok`. See navigate-result.ts.
      confirmed: z.boolean().optional(),
      /** The session the SDK reconnected as, when arrival was confirmed — it is a NEW id. */
      sessionId: z.string().optional(),
      /**
       * The URL where the navigated document landed when it differs from the requested target.
       */
      landedOn: z.string().optional(),
      /**
       * On confirmed:false — the budget (ms) that expired without the page coming back. Says which
       * of "Reticle stopped waiting" and "the page never came back" you are looking at.
       */
      waitedMs: z.number().optional(),
      note: z.string().optional(),
    },
    handler: async (deps, args) => {
      // reload:true is the absorbed reticle_refresh — same command, one fewer advertised tool.
      if (true === args['reload']) {
        // The reload branch has its own default, sized for a cold dev-server rebuild; the caller's
        // budget overrides it for the same reason it overrides the arrival wait below.
        const timeoutMs = asNumber(args['timeout_ms']) ?? RELOAD_RECONNECT_TIMEOUT_MS;
        const before = deps.sessions.resolve(asString(args['sessionId']));
        // The verdict floor moves HERE, before the page goes away. A reload destroys the document,
        // so every request that failed under the old one belongs to a page that no longer exists —
        // and a later assert defaulting its window to "the last thing that happened" must not reach
        // back past this point. Reported from the field as an assertion whose clauses all passed
        // coming back `contradicted` by hundreds of 500s against resources that were already gone.
        before.lastAct.markNavigated(before.elapsed());
        deps.recordings.markNavigated();
        await commandOrThrow(deps, asString(args['sessionId']), ReticleCommand.REFRESH, {
          hard: true === args['hard'],
        });
        // WAIT for the page to come back, rather than telling the agent to. The id survives the
        // reload, but the seconds between dispatch and the new HELLO are seconds in which every call
        // lands in the old, disconnected session — measured as reticle_run failing 5 of 5 on a page
        // that was healthy immediately afterwards. Returns on the first poll in the common case.
        const back = await waitForReconnect({
          current: () => deps.sessions.get(before.id),
          previous: before,
          timeoutMs,
          now: deps.now,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        });
        // Not a bare `{ ok: true }`. The URL branch below already discloses that `ok` means
        // DISPATCHED — the reload branch had identical semantics and said nothing, on the path most
        // likely to need it. See reload-result.
        return reloadResult(back, timeoutMs);
      }
      const requested = asString(args['url']);
      if (requested === undefined || 0 === requested.length)
        return { ok: false, reason: 'url required' };
      assertNotPaymentNavigation(requested);
      const named = asString(args['sessionId']);
      // A lease whose page has no SDK right now (it was navigated to an image, a PDF, another site):
      // the page is still the lease's, so it is navigated through the browser and reattaches when it
      // is back on the app, instead of answering "no connected session" for good.
      if (named !== undefined && deps.sessions.get(named) === undefined) {
        const leaseUrl = deps.pool?.leaseUrl(named);
        if (leaseUrl !== undefined) {
          return navigateLease(deps, named, carryReticleIdentity(leaseUrl, requested), args);
        }
      }
      // Record navigate as an action. Its window is usually empty (the page unloads and the SDK
      // reconnects), but the action record itself — "navigated to X" — is the causal fact worth keeping.
      const session = deps.sessions.resolve(asString(args['sessionId']));
      // A leased tab is addressed by a URL param, so navigating away from it used to strand the
      // lease — see carryReticleIdentity. A tab that claims no identity is untouched.
      const url = carryReticleIdentity(session.url, requested);
      // Sampled BEFORE dispatch, because that is the only moment it can be known. A session already
      // connected is not evidence that THIS navigation arrived: one on the target was there before,
      // and another tab (a lease) can reach the target during the wait. The arrival scan, which
      // reads whatever is at the target afterwards, cannot tell them apart on its own.
      const target = absoluteTarget(url, session.url);
      const priorIds = idsOpenAtDispatch(deps.sessions);
      // The document the tab is on NOW. Sampled before dispatch because the replacement can
      // connect while the NAVIGATE reply is still pending, and reading it after the await would
      // record the replacement as the starting document (#1320).
      const navigatedFromDocumentId = session.currentDocumentId;
      session.beginAction(ReticleTool.NAVIGATE, { url });
      // Same floor as the reload path above, for the same reason: going to a new URL replaces the
      // document just as thoroughly. `beginAction` attributes events to this action; it does not move
      // the window a later assert judges over, and those are two different jobs.
      session.lastAct.markNavigated(session.elapsed());
      deps.recordings.markNavigated();
      try {
        const result = (await commandOrThrow(
          deps,
          asString(args['sessionId']),
          ReticleCommand.NAVIGATE,
          { url },
        )) as { ok?: unknown; url?: unknown; reason?: unknown };
        // `ok` is the browser accepting the instruction, not the page arriving — see navigate-result.
        // The daemon is the only party that CAN see arrival (the SDK reconnects to it), so it looks,
        // for as long as the caller said to, instead of telling the agent to go poll
        // reticle_sessions itself. A refusal skips the wait: there is nothing to wait FOR.
        const timeoutMs = asNumber(args['timeout_ms']) ?? ARRIVAL_TIMEOUT_MS;
        const arrival =
          true === result.ok
            ? await awaitArrival(
                deps.sessions,
                target,
                {
                  // Keep the original Session object and URL so arrival detection can distinguish
                  // an in-progress navigation from a document that arrived somewhere else. The
                  // document identity lets a same-URL navigation wait for its replacement instead
                  // of confirming the document it is about to destroy (#1320).
                  navigatedSession: session,
                  navigatedFrom: session.url,
                  ...(navigatedFromDocumentId === undefined ? {} : { navigatedFromDocumentId }),
                  priorIds,
                },
                timeoutMs,
              )
            : null;
        const answer = navigateResult(result, arrival, timeoutMs);
        // A lease navigated off its app (an image, a PDF) is kept, and says what still works.
        const offApp =
          null === arrival &&
          true === result.ok &&
          deps.pool?.leaseUrl(session.id) !== undefined &&
          deps.sessions.get(session.id) === undefined;
        return offApp ? { ...answer, note: MSG_LEASE_WITHOUT_SDK } : answer;
      } finally {
        session.finishAction();
      }
    },
  },
];
