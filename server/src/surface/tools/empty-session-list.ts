/**
 * What `reticle_session { action: "list" }` answers when nothing is connected.
 *
 * An empty list is the most common thing that tool returns, and on its own it is a dead end: the
 * agent asked the one question it knows to ask and got no next step. So it carries why nothing is
 * connected, the executable next action, the last tab that was here, and, on a project that has
 * never connected, the next step: the zero-install lease, and the consent question for `init`.
 *
 * This call changes no file. It used to run `init` in an unwired project: an agent that only
 * listed sessions changed package.json, the lockfile and the build config, and started a second
 * dev server, which the user did not ask for. Wiring is the user's decision.
 */
import { dirname } from 'node:path';
import { z } from 'zod';
import { DiscoveryInvite, NextStepOffered, NoSessionAction } from '@reticlehq/core';
import { readProjectId } from '@/command/cli/ports/resolve/cli-port.js';
import { callingClientDirectory } from '@/hooks/client-directory.js';
import { initCommandIn } from '@/portal/session/dev-server/dev-command.js';
import {
  wiringConsent,
  zeroInstallLease,
  type NoSessionNextAction,
} from '@/portal/session/no-session-next-action.js';
import { noteNextStepOffered } from '@/telemetry/onboarding-firsts.js';

// The handshake reads the consent wording from here, so `mcp` needs no reach into `session`.
export { wiringConsent };
import type { ToolDeps } from './tool-kit.js';

/** The answers that mean "this app is not set up yet". */
const FIRST_RUN_ACTIONS: ReadonlySet<string> = new Set([
  NoSessionAction.RUN_INIT,
  NoSessionAction.START_DEV_SERVER,
  NoSessionAction.OPEN_APP,
]);

/** The answers where an app is up, so the lease can check it now. */
const LEASABLE_ACTIONS: ReadonlySet<string> = new Set([
  NoSessionAction.RUN_INIT,
  NoSessionAction.OPEN_APP,
]);
const LOCALHOST = 'http://localhost';

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
  next_step: z
    .object({
      offered: z.nativeEnum(NextStepOffered),
      lease: z.string().optional(),
      consent: z.string(),
    })
    .optional()
    .describe(
      'Present ONLY when this project is not wired. Nothing was installed and no file changed. `lease` is the call that checks the running app now, with nothing installed: do it first. `consent` is the question for wiring the app for good: ask the user, and run the command only if they agree.',
    ),
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

/**
 * The next step for an unwired project, or undefined when the project is wired or cannot be told.
 *
 * The lease leads when an app is up: it checks the change now and installs nothing. When no app
 * is up there is nothing to lease yet, so the consent question leads. Both name the consent
 * question, because only the user can agree to the file changes that `init` makes.
 */
function nextStepFor(
  deps: ToolDeps,
  dir: () => string,
  next: NoSessionNextAction | undefined,
): Record<string, unknown> | undefined {
  if (next === undefined || !FIRST_RUN_ACTIONS.has(next.action)) {
    return undefined;
  }
  const project = deps.firstRun?.projectDirectory(dir());
  if (project === undefined) {
    return undefined;
  }
  const consent = wiringConsent(initCommandIn(project));
  const leasable = LEASABLE_ACTIONS.has(next.action) && next.port !== undefined;
  const offered = leasable ? NextStepOffered.LEASE : NextStepOffered.INIT_CONSENT;
  noteNextStepOffered(offered, () => readProjectId(project) !== undefined);
  if (!leasable) {
    return { offered, consent };
  }
  return { offered, lease: zeroInstallLease(`${LOCALHOST}:${String(next.port)}`), consent };
}

/**
 * The next step for the calling project when another project's tab is the one connected.
 *
 * The list handler only used to reach {@link emptySessionList} when the daemon's whole list was
 * empty. A live tab in project A then answered project B's first call with A's sessions, and B
 * never heard that it was not wired.
 */
export function nextStepBesideLiveSessions(
  deps: ToolDeps,
  sessions: readonly { projectId?: string }[],
): Record<string, unknown> | undefined {
  const dir = callingClientDirectory();
  if (dir === undefined) {
    return undefined;
  }
  const projectId = readProjectId(dir);
  if (projectId !== undefined && sessions.some((session) => session.projectId === projectId)) {
    return undefined;
  }
  return nextStepFor(deps, () => dir, deps.sessions.noSessionNextAction());
}

/** The departed tab for this call: the caller's own project when it named one, else the daemon's newest. */
function departedForCaller(deps: ToolDeps): { id: string; url: string } | undefined {
  const dir = callingClientDirectory();
  if (dir === undefined) {
    return deps.sessions.lastKnown?.();
  }
  const projectId = readProjectId(dir);
  if (projectId === undefined) {
    return undefined;
  }
  return deps.sessions.lastKnownFor?.(projectId);
}

export function emptySessionList(deps: ToolDeps, sessions: unknown[]): Record<string, unknown> {
  // The lead and its next action: the full differential (~3 KB of ranked causes) read as
  // speculation on the call an agent makes first. Optional-call: test stubs predate the lead.
  const why = deps.sessions.noSessionLead?.() ?? deps.sessions.noSessionHint();
  // The executable half. `why` is for the human reading the transcript; this is the one the
  // agent acts on, so it never has to parse a paragraph to find a command inside it.
  const next = deps.sessions.noSessionNextAction();
  // The project the client is in, not the directory the daemon was started in. One daemon serves
  // every project; the proxy names its cwd on the call. With no caller (an embed, a test) it is the
  // daemon's own project. A daemon outside any project offers no step.
  // ponytail: cwd, not an MCP roots/list round trip. Roots are the upgrade when a client launches
  // outside the project but names it.
  const nextStep = nextStepFor(
    deps,
    () => callingClientDirectory() ?? dirname(deps.reticleRoot),
    next,
  );
  // The last tab, when one was here. Optional-call: test stubs of SessionManager predate it.
  const known = departedForCaller(deps);
  const lastKnown = undefined === known ? undefined : { sessionId: known.id, url: known.url };
  return {
    sessions,
    ...(why === undefined ? {} : { why }),
    ...(next === undefined ? {} : { next_action: next }),
    ...(nextStep === undefined ? {} : { next_step: nextStep }),
    ...(undefined === lastKnown ? {} : { lastKnown }),
    // Setup that never connects is where most people give up; it is the talk worth having.
    talk_to_us: DiscoveryInvite.AGENT,
  };
}
