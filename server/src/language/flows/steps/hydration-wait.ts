/**
 * Wait for the page to hydrate before step 1 of a replay (#1654).
 *
 * With `@reticlehq/react`, the SDK can connect before React attached its handlers: Next commits the
 * shell, and a slow Suspense boundary hydrates later. Queries answer and the server-rendered button is
 * there, but a click on it does nothing, and the step's `expect` fails on a correct app.
 *
 * The adapter says when hydration is done: it fires `reticle:hydration-complete`, and its render store
 * reports `hydrated`. A page without the adapter has no such store, and replay does not wait on it.
 */
import { z } from 'zod';
import {
  EventType,
  RETICLE_HYDRATION_SIGNAL,
  RETICLE_RENDERS_STORE,
  RenderStatsField,
  ReticleCommand,
  asString,
  type CommandResult,
  type HydrationWait,
  type ReticleEvent,
} from '@reticlehq/core';

/** The longest replay waits for hydration. A cold dev server can take seconds to load a big bundle. */
export const HYDRATION_WAIT_MS = 10_000;
/** How often replay looks for the signal while it waits. */
const HYDRATION_POLL_MS = 50;
/** The bound on the one store read. A page that does not answer is not one to wait for. */
const STATE_READ_TIMEOUT_MS = 2_000;

/** The scoped store read's answer (`readState` with a `path`). */
const HydratedReadSchema = z.object({ found: z.boolean(), value: z.unknown() });

/** The part of a replay session that the wait uses. */
interface HydrationSession {
  command(name: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<CommandResult>;
  eventsSince(cursor: number): ReticleEvent[];
}

interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

function signalled(session: HydrationSession): boolean {
  return session
    .eventsSince(0)
    .some(
      (event) =>
        EventType.SIGNAL === event.type &&
        RETICLE_HYDRATION_SIGNAL === asString(event.data['name']),
    );
}

/** True only when the adapter is on the page and says a part is not hydrated yet. */
async function adapterSaysPending(session: HydrationSession): Promise<boolean> {
  try {
    const reply = await session.command(
      ReticleCommand.STATE_READ,
      { store: RETICLE_RENDERS_STORE, path: RenderStatsField.HYDRATED },
      STATE_READ_TIMEOUT_MS,
    );
    if (!reply.ok) {
      return false;
    }
    const read = HydratedReadSchema.safeParse(reply.result);
    // An older adapter has no `hydrated` field. Then nothing says to wait, so replay does not.
    return read.success && read.data.found && false === read.data.value;
  } catch {
    return false;
  }
}

/**
 * Wait, up to `budgetMs`, for the page to hydrate.
 *
 * Returns undefined when replay did not have to wait, or the page hydrated inside the bound. Returns
 * the wait when the bound ran out, so the result can say that step 1 ran on a page that was not
 * hydrated.
 */
export async function awaitHydration(
  session: HydrationSession,
  clock: Clock,
  budgetMs: number = HYDRATION_WAIT_MS,
): Promise<HydrationWait | undefined> {
  // The signal can fire before replay starts. Then the page is ready and nothing is asked.
  if (signalled(session) || !(await adapterSaysPending(session))) {
    return undefined;
  }
  const started = clock.now();
  for (;;) {
    const waitedMs = clock.now() - started;
    if (waitedMs >= budgetMs) {
      return { waitedMs, budgetMs };
    }
    await clock.sleep(Math.min(HYDRATION_POLL_MS, budgetMs - waitedMs));
    if (signalled(session)) {
      return undefined;
    }
  }
}
