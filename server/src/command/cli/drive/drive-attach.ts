/**
 * Who gets the bridge port when `reticle drive <url>` runs — and what happens when the answer is
 * "not you".
 *
 * `drive` used to bind :4400 unconditionally. A daemon on that port is the NORMAL state the moment
 * any MCP client has started one, so the bind died with a raw `node:net` EADDRINUSE stack — in the
 * exact situation the product tells people to run `drive` in, since `reticle_sessions` recommends it
 * for a throttled tab and a throttled tab nearly always coexists with the daemon that makes the bind
 * impossible. The documented workaround is worse than the bug, because `reticle stop` frees the
 * port and the MCP proxy respawns a daemon into the gap before
 * `drive` can bind, so the "escape hatch" is a race the user cannot win.
 *
 * The fix is arbitration, not a better race:
 *
 * - **A healthy daemon owns the port → ATTACH.** Driving is a REQUEST to the process that already
 *   owns the browser plane, not a competing process. The daemon hands out a pooled, isolated,
 *   never-throttled context (the same one `reticle_lease` returns) and the caller gets back a
 *   sessionId every Reticle tool — including the ones the agent already has open on that daemon —
 *   can address. Nothing is bound, so there is nothing to race for and no reason to run `stop`.
 * - **Nothing on the port → BIND.** Unchanged: `drive` is still a self-contained foreground engine
 *   with its own browser when it can have the port.
 * - **A stranger owns the port → REFUSE**, naming the holder. Neither binding nor attaching can
 *   work, and pretending otherwise is the lie this module exists to remove.
 *
 * Making `stop` block until the port is genuinely free (and muzzling the proxy meanwhile) was the
 * alternative. It is strictly more machinery — a cross-process handoff, a suppression window, a new
 * way for the proxy to be wrong — to earn the same browser the daemon can already open, and it would
 * still leave `drive` unable to run while an agent is working. Attaching deletes the race instead of
 * refereeing it.
 */

import * as http from 'node:http';
import { DRIVE_PATH, LOOPBACK_HOST } from '@reticlehq/core';
import { PortPresence } from '@/command/daemon/binding/port-presence.js';
import { summarizeStatus } from '@/command/daemon/binding/daemon-status-probe.js';

/** What `drive` should do about the port, given what is on it. */
export const DriveMode = {
  /** Nothing is listening: bind it and run the foreground engine. */
  BIND: 'bind',
  /** Our daemon is serving it: ask that daemon for a driveable session. */
  ATTACH: 'attach',
  /** Someone else holds it: neither is possible. */
  REFUSE: 'refuse',
} as const;
export type DriveMode = (typeof DriveMode)[keyof typeof DriveMode];

/** Pure. Exhaustive by switch, so a fourth presence has to decide what driving means for it. */
export function decideDriveMode(presence: PortPresence): DriveMode {
  switch (presence) {
    case PortPresence.DAEMON:
      return DriveMode.ATTACH;
    case PortPresence.FOREIGN:
      return DriveMode.REFUSE;
    case PortPresence.FREE:
      return DriveMode.BIND;
  }
}

/** A driveable session the daemon opened on our behalf. */
interface DriveSession {
  sessionId: string;
  /** Whether the tab's SDK actually registered — false ⇒ the app may not embed @reticlehq/browser. */
  ready: boolean;
  /** How long the session survives untouched. Absent from a daemon that does not report it. */
  expiresInMs?: number;
  /** The daemon's own diagnosis when the tab did not connect. */
  hint?: string;
}

type DriveAttachResult = { ok: true; session: DriveSession } | { ok: false; reason: string };

/** POST the drive request. Injected so the decision logic is tested without a socket. */
type DrivePost = (
  port: number,
  path: string,
  body: string,
) => Promise<{ status: number; body: string }>;

/** The daemon answers a tool refusal (app down, pool unavailable) as a 200 with this field. */
const ERROR_FIELD = 'error';

/**
 * Turn the daemon's answer into a session or a sentence. Pure.
 *
 * Every failure branch has to end in something the reader can DO, because this is the path that
 * replaces the EADDRINUSE stack — an answer that is merely accurate ("404") repeats the original
 * mistake in a politer font.
 */
export function readAttachResponse(
  port: number,
  url: string,
  res: { status: number; body: string },
): DriveAttachResult {
  if (404 === res.status) {
    return {
      ok: false,
      reason:
        `the Reticle daemon on :${String(port)} is older than this CLI and cannot open a drive ` +
        'session — stop it with `reticle stop` and retry (the next tool call starts a current one).',
    };
  }
  if (200 !== res.status) {
    return {
      ok: false,
      reason:
        `the Reticle daemon on :${String(port)} refused to open a drive session ` +
        `(HTTP ${String(res.status)}: ${res.body.slice(0, 200)}).`,
    };
  }
  const notASession = {
    ok: false as const,
    reason:
      `the Reticle daemon on :${String(port)} answered the drive request with something that is ` +
      'not a session. Stop it with `reticle stop` and retry.',
  };
  const parsed: unknown = parseJson(res.body);
  if (typeof parsed !== 'object' || null === parsed) return notASession;
  const record = parsed as Record<string, unknown>;
  const error = record[ERROR_FIELD];
  if ('string' === typeof error) {
    return { ok: false, reason: `could not drive ${url} — ${error}` };
  }
  const sessionId = record['sessionId'];
  if ('string' !== typeof sessionId || 0 === sessionId.length) {
    return {
      ok: false,
      reason:
        `the Reticle daemon on :${String(port)} answered the drive request with something that is ` +
        'not a session. Stop it with `reticle stop` and retry.',
    };
  }
  const expiresInMs = record['expiresInMs'];
  const hint = record['hint'];
  return {
    ok: true,
    session: {
      sessionId,
      ready: true === record['ready'],
      ...('number' === typeof expiresInMs ? { expiresInMs } : {}),
      ...('string' === typeof hint ? { hint } : {}),
    },
  };
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** Ask the daemon on `port` to open a driveable browser at `url`. */
export async function requestDriveSession(
  port: number,
  url: string,
  post: DrivePost = postJson,
): Promise<DriveAttachResult> {
  let res: { status: number; body: string };
  try {
    res = await post(port, DRIVE_PATH, JSON.stringify({ url }));
  } catch (error: unknown) {
    // The daemon answered /status a moment ago and is gone now — a shutdown, a crash, a `stop` from
    // another terminal. Retrying is the whole answer, and it is the one thing an errno never says.
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason:
        `could not reach the Reticle daemon on :${String(port)} (${message}) — it answered a ` +
        'moment ago, so it is shutting down or has just been stopped. Retry the command.',
    };
  }
  return readAttachResponse(port, url, res);
}

/** Which app the attached page says it is, beside the project this directory names. */
export interface AttachedApp {
  /** The project the page reported when it connected. */
  projectId?: string;
  title?: string;
  /** The `projectId` in this directory's `.reticle.json`, when there is one. */
  expectedProjectId?: string;
}

/**
 * Control characters, and the 0x80 to 0x9f range some terminals also obey. Built with
 * `fromCharCode` to keep them out of a regex literal (no-control-regex).
 */
const TERMINAL_CONTROLS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}]`,
  'g',
);

/**
 * A value the page chose, safe to print. The project id and title come from the page and are
 * written straight to the terminal (and into the JSON line beside it), so a page could otherwise
 * move the cursor or retitle the window. Each control character becomes U+FFFD, so the reader can
 * still see that something was there.
 */
function printable(value: string): string {
  return value.replace(TERMINAL_CONTROLS, '\uFFFD');
}

/**
 * Pick the attached session out of a `/status` payload. Pure.
 *
 * The drive answer is a lease result, which carries no project: the page reports that itself when
 * it connects, and `/status` is where it is already listed.
 */
export function attachedApp(
  status: unknown,
  sessionId: string,
  expectedProjectId: string | undefined,
): AttachedApp {
  const row = summarizeStatus(status).sessions.find((s) => s.sessionId === sessionId);
  return {
    ...(row?.projectId === undefined ? {} : { projectId: printable(row.projectId) }),
    ...(row?.title === undefined ? {} : { title: printable(row.title) }),
    ...(expectedProjectId === undefined ? {} : { expectedProjectId }),
  };
}

/**
 * The project and title, and a warning when this directory names a different project.
 *
 * In a monorepo the port you meant for one app is easily held by another, and the port, url and
 * session id read the same either way. Only warned when both sides are known: a page with no
 * project id proves nothing, and neither does a directory without a `.reticle.json`.
 */
function describeApp(url: string, app: AttachedApp): { label: string; warning: string } {
  const named = [
    ...(app.projectId === undefined ? [] : [`project ${JSON.stringify(app.projectId)}`]),
    ...(app.title === undefined ? [] : [JSON.stringify(app.title)]),
  ];
  const label = 0 === named.length ? '' : ` (${named.join(', ')})`;
  const differs =
    app.projectId !== undefined &&
    app.expectedProjectId !== undefined &&
    app.projectId !== app.expectedProjectId;
  const warning = differs
    ? ` Warning: this directory's .reticle.json is project ${JSON.stringify(String(app.expectedProjectId))}, ` +
      `but the page at ${url} is project ${JSON.stringify(String(app.projectId))}, so another app is ` +
      'probably serving that port. Check which dev server is on it before trusting anything this ' +
      'session reports.'
    : '';
  return { label, warning };
}

/** The success line. Names the session, because that is the handle everything downstream needs. */
export function describeAttached(
  port: number,
  url: string,
  session: DriveSession,
  app: AttachedApp = {},
): string {
  const life =
    session.expiresInMs === undefined
      ? ''
      : ` It is released after ${String(Math.round(session.expiresInMs / 1000))}s untouched; any ` +
        'tool call against it resets that.';
  if (!session.ready) {
    return (
      `the Reticle daemon on :${String(port)} opened ${url} as session ${session.sessionId}, but ` +
      `the page did not connect to the bridge. ${session.hint ?? 'Check that the app embeds @reticlehq/browser.'}`
    );
  }
  const { label, warning } = describeApp(url, app);
  return (
    `attached to the Reticle daemon on :${String(port)} — it is driving ${url}${label} as session ` +
    `${session.sessionId}, which every Reticle tool can address.${life}${warning}`
  );
}

/**
 * What an attach cannot honour: the window.
 *
 * `drive` documents a HEADED browser and parses `--headless` as the opt-out, but the attach path
 * POSTs a url and nothing else — the daemon answers from a pool it launched headless at boot, and no
 * per-request flag can change a browser that is already running. So the run is invisible, which is
 * the half of the field report that reads "the app starts to run headlessly".
 *
 * Saying so is the honest half. The other half is that the run is no longer unwatchable: the HUD
 * feed is mirrored to every other tab of the same app (see Session.setViewers), so a tab the human
 * already has open shows the narration and the counters as the leased context is driven.
 */
export function driveHeadlessOnAttach(port: number, url: string): string {
  return (
    `note: this session runs inside the daemon on :${String(port)}, whose browser was launched ` +
    'headless — there is no window to show, and `--headless` is not a per-drive choice. Open ' +
    `${url} in your own browser to watch: any tab of that app mirrors this session's HUD. To get a ` +
    'window instead, stop the daemon and run `reticle drive` again with the port free.'
  );
}

/**
 * A stranger holds the port, in words `drive` can honour.
 *
 * The shared sentence for a foreign holder offers `--port`, which is true of `serve`, `status` and
 * `doctor` and false here: `drive` rejects that flag outright and reads the port from the
 * environment. Sending someone to a flag that does not exist is a second dead end at the moment they
 * have already hit one, so the route that works is named instead. The shared sentence is passed in
 * rather than rebuilt, so the description of the holder stays in one place.
 */
export function driveForeignHolder(description: string): string {
  return `${description} \`drive\` takes the port from RETICLE_PORT or .reticle.json, not a flag.`;
}

/**
 * The port went from free to taken between the probe and the bind.
 *
 * The probe cannot close that window, and the loser of the race learns about it as an EADDRINUSE on
 * the server object, outside every promise `drive` holds. It is a DISTINCT state from a foreign
 * holder — the likeliest winner is a daemon the proxy just spawned — so it gets its own sentence,
 * and that sentence is "run it again", because the second run attaches instead of binding.
 */
export function driveRaceLost(port: number, url: string): string {
  return (
    `:${String(port)} was taken while \`drive\` was starting — a daemon (probably one the agent's ` +
    `MCP proxy just spawned) now owns it. Run \`reticle drive ${url}\` again: it will attach to ` +
    'that daemon instead of binding the port.'
  );
}

/** How long the drive request waits. A pooled context has to launch a browser on a cold daemon. */
const DRIVE_REQUEST_TIMEOUT_MS = 60_000;

/** The real POST. Loopback-only: the daemon is always local, and the drive plane never leaves the host. */
function postJson(
  port: number,
  path: string,
  body: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: LOOPBACK_HOST,
        port,
        path,
        method: 'POST',
        timeout: DRIVE_REQUEST_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let received = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (received += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: received }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`no answer within ${String(DRIVE_REQUEST_TIMEOUT_MS)}ms`));
    });
    req.end(body);
  });
}
