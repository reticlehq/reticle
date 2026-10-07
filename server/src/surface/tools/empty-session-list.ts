/**
 * What `reticle_session { action: "list" }` answers when nothing is connected.
 *
 * An empty list is the most common thing that tool returns, and on its own it is a dead end: the
 * agent asked the one question it knows to ask and got no next step. So it carries why nothing is
 * connected, the executable next action, the last tab that was here, and, on a project that has
 * never connected, the first-run wiring itself (see first-run-wiring.ts).
 */
import { dirname } from 'node:path';
import { z } from 'zod';
import { DiscoveryInvite, NoSessionAction } from '@reticlehq/core';
import type { ToolDeps } from './tool-kit.js';

/** The answers that mean "this app is not set up yet", which a first run can settle by wiring it. */
const FIRST_RUN_ACTIONS: ReadonlySet<string> = new Set([
  NoSessionAction.RUN_INIT,
  NoSessionAction.START_DEV_SERVER,
  NoSessionAction.OPEN_APP,
]);

/** The fields only an empty list carries, declared so a schema-aware client does not strip them. */
export const EMPTY_SESSION_LIST_OUTPUT = {
  why: z
    .string()
    .optional()
    .describe(
      'Present ONLY when `sessions` is empty: why nothing is connected, and the next action that fixes it. An empty list is never the end of the road — read this before concluding the app cannot be driven.',
    ),
  next_action: z
    .object({
      action: z.nativeEnum(NoSessionAction),
      command: z.string().optional(),
      port: z.number().optional(),
      reason: z.string(),
    })
    .optional()
    .describe(
      "Present ONLY when `sessions` is empty: the same answer as `why`, executable. `command` is the LITERAL command to run, sourced from this project's own package.json scripts and lockfile — it is absent, never guessed, when the project declares no dev script. `action` is one of daemon_split | start_dev_server | run_init | open_app | reopen_app. `daemon_split` outranks the rest and means the app IS running and instrumented, on a DIFFERENT daemon than the one you are attached to — do not start or re-init anything, read `reason`.",
    ),
  talk_to_us: z
    .string()
    .optional()
    .describe(
      'Present ONLY when `sessions` is empty: a call with the founder for the person you are working with. Offer it; never act on it.',
    ),
  wired: z
    .record(z.unknown())
    .optional()
    .describe('Files the first run changed (`steps`); tell the user.'),
  lastKnown: z
    .object({
      sessionId: z.string(),
      url: z.string(),
    })
    .optional()
    .describe(
      'Present ONLY when `sessions` is empty AND a tab was connected to this daemon earlier: the last sessionId and URL that tab was on when it disappeared. A route that 500s tears the page down and the SDK never reconnects — this is the last thing we knew, not a route-500 verdict. An empty list with no lastKnown is a tab that never arrived.',
    ),
};

export async function emptySessionList(
  deps: ToolDeps,
  sessions: unknown[],
): Promise<Record<string, unknown>> {
  const why = deps.sessions.noSessionHint();
  // The executable half. `why` is for the human reading the transcript; this is the one the
  // agent acts on, so it never has to parse a paragraph to find a command inside it.
  const next = deps.sessions.noSessionNextAction();
  // The first run wires the app, not the installation: the daemon runs init itself, once,
  // in its own project, and says what it changed. A daemon outside any project asks instead.
  // Not only on `run_init`: an unwired app whose dev server is not running yet answers
  // `start_dev_server`, which is the commonest first run of all, and init starts that server itself.
  // `projectDirectory` refuses a project that is already wired, so a wired app is never re-run.
  const dir =
    next !== undefined && FIRST_RUN_ACTIONS.has(next.action)
      ? deps.firstRun?.projectDirectory(dirname(deps.reticleRoot))
      : undefined;
  if (dir !== undefined && deps.firstRun !== undefined) {
    const wired = await deps.firstRun.wire(dir);
    const connected = deps.sessions.list();
    if (wired.ok && 0 < connected.length) return { sessions: connected, wired };
    return { sessions, wired, ...(why === undefined ? {} : { why }) };
  }
  // The last tab, when one was here. Optional-call: test stubs of SessionManager predate it.
  const known = deps.sessions.lastKnown?.();
  const lastKnown = undefined === known ? undefined : { sessionId: known.id, url: known.url };
  return {
    sessions,
    ...(why === undefined ? {} : { why }),
    ...(next === undefined ? {} : { next_action: next }),
    ...(undefined === lastKnown ? {} : { lastKnown }),
    // Setup that never connects is where most people give up; it is the talk worth having.
    talk_to_us: DiscoveryInvite.AGENT,
  };
}
