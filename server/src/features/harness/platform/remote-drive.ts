/**
 * A drive somebody asked for in the platform's chat, run here, on their own machine.
 *
 * The platform cannot open `localhost`, and it never tries: the chat files the drive on the platform,
 * and this daemon — which already calls out to the platform for every Harness turn — asks whether one
 * is waiting for its project, drives the app it has connected, and reports how it ended. Every call
 * goes OUT from this machine, so nothing listens for the platform and no port is opened.
 *
 * It only asks while an app is connected. A drive taken with nothing to drive would fail for a reason
 * the person can fix in ten seconds (open the app), and leaving it unclaimed lets the chat tell them
 * exactly that. One drive at a time: a second request waits for the first to finish.
 */
import {
  DriveMode,
  DriveTarget,
  LinkPath,
  PLATFORM_LINK_VERSION,
  PresenterTone,
  TOOL_SESSION_LIMITS,
  parseDriveSpec,
  parseToolSessionReply,
  type DriveApplied,
  type DriveSpec,
  type SpecIgnored,
  type ToolSessionResult,
} from '@reticlehq/core';
import { serverOptionsFromEnv } from './server-driver.js';

/** The app the chat attached a drive to: `local-apps.ts`'s key, and where it was last open. */
export interface AttachedApp {
  key: string;
  url: string | null;
}

/**
 * How often to ask while an app is connected.
 *
 * ponytail: a poll, one small GET per interval per connected daemon; a long-poll or a stream on the
 * platform side is the upgrade if the chat's wait for a claim ever needs to be shorter than this.
 */
export const REMOTE_DRIVE_POLL_MS = 3_000;
const REQUEST_TIMEOUT_MS = 10_000;
/**
 * How often the live picture is taken while a chat-requested drive runs. About one a second is what
 * reads as video in the chat without turning a minute's drive into megabytes.
 */
export const REMOTE_DRIVE_FRAME_MS = 1_000;
/** The same JPEG quality the platform's own checks film at: about 40 KB a picture. */
export const REMOTE_DRIVE_JPEG_QUALITY = 50;

/** What the driven tab's HUD says once a chat-requested drive is over. */
export const REMOTE_DRIVE_ENDED = {
  PROVED: 'Harness drive finished: proved',
  NOT_PROVED: 'Harness drive finished: not proved',
} as const;

/**
 * End the driven tab's session once its drive is over, so its HUD stops counting "planning next
 * action" for an agent that is not there. Auto-ended, not ended: the next agent or drive revives it.
 */
export function endDrivenTab(
  tab: { autoEnd(text: string, tone: PresenterTone): void } | undefined,
  outcome: RemoteDriveOutcome,
): void {
  tab?.autoEnd(
    outcome.ok ? REMOTE_DRIVE_ENDED.PROVED : REMOTE_DRIVE_ENDED.NOT_PROVED,
    outcome.ok ? PresenterTone.CALM : PresenterTone.WARN,
  );
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface RemoteDriveOutcome {
  ok: boolean;
  summary: string;
  /** The verdict on the goal (see `driveVerdict`), so the platform keeps the drive as a check. */
  verdict?: DriveVerdict;
  /** The address the drive was on, for the check the platform keeps. */
  url?: string;
  /** The runs this drive syncs as, so the platform shows the drive once. */
  runIds?: readonly string[];
  /**
   * Whether any picture of the drive reached the platform. False for a drive in the person's own
   * tab, which only the SDK reaches and no camera does, so the chat can say why there is no video.
   * Set by `startRemoteDrives`, never by the drive.
   */
  filmed?: boolean;
}

export type DriveVerdict = 'yes' | 'no' | 'unknown';

export interface RemoteDriveDeps {
  /** The environment with this machine's linked credential in it, resolved on every ask. */
  env: () => Promise<Record<string, string | undefined>>;
  /** Whether an app is connected to drive. */
  connected: () => boolean;
  /**
   * The tab to drive for `goal`, or undefined to let the drive choose. One tab, picked once and used
   * for the whole drive and its pictures: with two tabs open, a drive that names none is refused on
   * every call ("multiple sessions connected"), and the pictures would be of whichever tab was asked.
   * Null: no connected tab belongs to the project `apiKey` is for, so the drive is refused.
   * `app`: the app the chat attached the drive to, when it named one; only its tabs may be driven.
   */
  pick?: (
    goal: string,
    apiKey: string,
    app?: AttachedApp,
  ) => Promise<string | null | undefined> | string | undefined;
  /**
   * Make ready the tab a drive with a spec runs in: the person's own (as `pick` would choose it) or
   * one opened for it, headless or in a window, with the HUD as the spec asks. Answers what it applied
   * and what it could not. A null `sessionId` refuses the drive, as a null from `pick` does.
   * Absent: `pick` chooses, and the spec's other fields are reported as unavailable.
   */
  prepare?: (drive: {
    goal: string;
    apiKey: string;
    app?: AttachedApp;
    spec: DriveSpec;
  }) => Promise<{
    sessionId: string | null | undefined;
    applied: DriveApplied;
    ignored: SpecIgnored[];
    /** Why the drive cannot run, said to the person instead of the no-tab refusal. */
    refusal?: string;
  }>;
  /**
   * Reticle's tools on the driven tab, for a drive the platform orchestrates. Absent: a platform
   * drive is refused, and this daemon does not report the tool-session capability.
   */
  session?: (sessionId: string | undefined) => {
    /** What it can run, as the model is shown each tool: sent once, on the first ask. */
    tools?: readonly { name: string; description: string; inputSchema: Record<string, unknown> }[];
    invoke: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  };
  /** The clock for how long each session call took. */
  now?: () => number;
  /** Drive the app toward `goal`, in `sessionId`. A throw is reported as a failed drive, in its own words. */
  drive: (goal: string, sessionId: string | undefined) => Promise<RemoteDriveOutcome>;
  /**
   * What the driven tab shows now, as a JPEG, or undefined when it cannot be captured (a tab this
   * daemon did not launch). Absent: the drive runs with no picture, and the chat shows its steps.
   */
  frame?: (sessionId: string | undefined) => Promise<Uint8Array | undefined>;
  frameIntervalMs?: number;
  /**
   * Called once the drive is over, however it ended, so the driven tab's HUD stops reading
   * "planning next action". Nothing else tells it: the drive has no agent to end its session.
   */
  settle?: (sessionId: string | undefined, outcome: RemoteDriveOutcome) => void;
  fetch?: FetchLike;
  intervalMs?: number;
  /** A line for the daemon log. */
  log?: (line: string) => void;
}

export interface RemoteDrives {
  /**
   * One ask, now. Resolves once any drive it took has been reported. With `platform`, ask with that
   * credential whether or not an app is connected: the platform said a drive is waiting for it.
   */
  tick: (platform?: { url: string; apiKey: string }) => Promise<void>;
  stop: () => void;
}

export function startRemoteDrives(deps: RemoteDriveDeps): RemoteDrives {
  const doFetch: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  let busy = false;
  let stopped = false;

  const tick = async (told?: { url: string; apiKey: string }): Promise<void> => {
    if (busy || stopped || (undefined === told && !deps.connected())) return;
    const platform = told ?? serverOptionsFromEnv(await deps.env());
    if (platform === undefined) return;
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${platform.apiKey}`,
    };
    busy = true;
    try {
      const res = await doFetch(`${platform.url}${LinkPath.NEXT_DRIVE}`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) return;
      const drive = (
        (await res.json()) as {
          drive?: {
            id?: unknown;
            goal?: unknown;
            record?: unknown;
            appKey?: unknown;
            appUrl?: unknown;
            spec?: unknown;
          } | null;
        }
      ).drive;
      if (null === drive || undefined === drive) return;
      if ('string' !== typeof drive.id || 'string' !== typeof drive.goal) return;
      deps.log?.(`reticle: driving a request from the platform chat: ${drive.goal}`);
      const driveId = drive.id;
      const driveUrl = `${platform.url}${LinkPath.driveResult(driveId)}`;
      const app: AttachedApp | undefined =
        'string' === typeof drive.appKey
          ? { key: drive.appKey, url: 'string' === typeof drive.appUrl ? drive.appUrl : null }
          : undefined;
      // Read field by field: a spec from a newer platform still drives, minus what is unknown here.
      const parsed = parseDriveSpec(drive.spec);
      const prepared =
        deps.prepare === undefined
          ? {
              sessionId: await deps.pick?.(drive.goal, platform.apiKey, app),
              applied: { target: DriveTarget.TAB, mode: DriveMode.LOCAL },
              ignored: [],
            }
          : await deps.prepare({
              goal: drive.goal,
              apiKey: platform.apiKey,
              ...(app === undefined ? {} : { app }),
              spec: parsed.spec,
            });
      const ignored = [...parsed.ignored, ...prepared.ignored];
      const picked = prepared.sessionId;
      if (null === picked) {
        await doFetch(driveUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            ok: false,
            summary: ('refusal' in prepared ? prepared.refusal : undefined) ?? NO_OWN_TAB,
            verdict: 'unknown',
            filmed: false,
            applied: prepared.applied,
            ignored,
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        return;
      }
      const sessionId = picked;
      const frame = deps.frame;
      // Only when the person asked to watch: a picture of their app leaves this machine for it.
      const filming =
        false === drive.record || frame === undefined
          ? undefined
          : film(
              () => frame(sessionId),
              deps.frameIntervalMs ?? REMOTE_DRIVE_FRAME_MS,
              (jpeg) =>
                doFetch(`${platform.url}${LinkPath.driveFrames(driveId)}`, {
                  method: 'POST',
                  headers,
                  body: JSON.stringify({ jpeg }),
                  signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                }),
            );
      // The platform decides every step; this daemon only runs the tools it is told to.
      const session = deps.session;
      if (DriveMode.PLATFORM === prepared.applied.mode && session !== undefined) {
        try {
          const tools = session(sessionId);
          await runToolSession(
            (body) =>
              doFetch(`${platform.url}${LinkPath.driveSession(driveId)}`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
              }),
            tools,
            {
              applied: prepared.applied,
              ignored,
              ...(tools.tools === undefined ? {} : { tools: tools.tools }),
            },
            deps.now ?? (() => Date.now()),
          );
        } finally {
          await filming?.stop();
          deps.settle?.(sessionId, { ok: true, summary: '' });
        }
        return;
      }
      let outcome: RemoteDriveOutcome;
      let framesSent = 0;
      try {
        outcome = await deps.drive(drive.goal, sessionId);
      } catch (error) {
        outcome = { ok: false, summary: error instanceof Error ? error.message : String(error) };
      } finally {
        framesSent = (await filming?.stop()) ?? 0;
      }
      deps.settle?.(sessionId, outcome);
      await doFetch(driveUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...outcome,
          filmed: 0 < framesSent,
          applied: prepared.applied,
          ignored,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // Offline, or the platform is down: the next tick asks again. The local daemon never fails for it.
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void tick(), deps.intervalMs ?? REMOTE_DRIVE_POLL_MS);
  timer.unref();
  return {
    tick,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * A drive the platform orchestrates: post what the last calls did, run the next batch, until the
 * platform says the drive is over, stops answering, or the drive reaches its call budget. Every call
 * is answered, failed ones included: the platform decides what a failure means.
 */
async function runToolSession(
  post: (body: unknown) => Promise<Response>,
  tools: { invoke: (tool: string, args: Record<string, unknown>) => Promise<unknown> },
  first: { applied: DriveApplied; ignored: SpecIgnored[]; tools?: readonly unknown[] },
  now: () => number,
): Promise<void> {
  let results: ToolSessionResult[] = [];
  let made = 0;
  for (;;) {
    const res = await post({
      protocol: PLATFORM_LINK_VERSION,
      results,
      ...(0 === made ? first : {}),
    });
    // A drive the platform no longer knows, or an answer it could not give: stop, never guess.
    if (!res.ok) return;
    const reply = parseToolSessionReply(await res.json());
    if (reply.done) return;
    results = [];
    for (const call of reply.calls) {
      if (made >= TOOL_SESSION_LIMITS.MAX_CALLS) return;
      made += 1;
      const at = now();
      try {
        const result = await tools.invoke(call.tool, call.args);
        results.push({ seq: call.seq, ok: true, result, ms: now() - at });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ seq: call.seq, ok: false, error: message, ms: now() - at });
      }
    }
  }
}

/**
 * Take a picture every `everyMs` and send it, until stopped. One capture at a time, and a picture
 * identical to the last one sent is skipped: a page standing still is not worth a request a second.
 * A failed capture or send is skipped too, never fatal: the drive matters, the picture of it less.
 * `stop` answers how many pictures were sent.
 */
function film(
  frame: () => Promise<Uint8Array | undefined>,
  everyMs: number,
  send: (jpeg: string) => Promise<{ ok: boolean }>,
): { stop: () => Promise<number> } {
  let last: string | undefined;
  let sent = 0;
  let busy: Promise<void> | undefined;
  const shoot = async (): Promise<void> => {
    try {
      const shot = await frame();
      if (shot === undefined) return;
      const jpeg = Buffer.from(shot).toString('base64');
      if (jpeg === last) return;
      last = jpeg;
      // Counted only once the platform took it: a refused picture is not a filmed drive.
      if ((await send(jpeg)).ok) sent += 1;
    } catch {
      // The next tick tries again.
    }
  };
  const timer = setInterval(() => {
    if (busy === undefined) busy = shoot().finally(() => (busy = undefined));
  }, everyMs);
  timer.unref();
  return {
    stop: async () => {
      clearInterval(timer);
      await busy;
      return sent;
    },
  };
}

/** What a connected tab says about itself, as far as picking one goes. */
/** The refusal a drive gets when every connected tab belongs to some other project. */
export const NO_OWN_TAB =
  "No tab of this project is connected to Reticle on this machine, and a request is never run in another project's app. Open this project's app, then ask again.";

/**
 * `pickDriveSession` over the tabs of the project `apiKey` is for, or null when there are none. One
 * daemon serves every project on the machine but polls with ONE credential, so without this a
 * request made in project A drove project B's tab and sent pictures of it to A's chat.
 */
export async function pickOwnDriveSession(
  tabs: readonly DriveCandidate[],
  goal: string,
  apiKey: string,
  keyOf: (sessionId: string) => Promise<string | undefined>,
): Promise<string | null> {
  const own: DriveCandidate[] = [];
  for (const tab of tabs) {
    const key = await keyOf(tab.sessionId).catch(() => undefined);
    if (key === apiKey) own.push(tab);
  }
  return pickDriveSession(own, goal) ?? null;
}

export interface DriveCandidate {
  sessionId: string;
  url: string;
  lastSeenMs: number;
  hidden: boolean;
}

/** The address of an http(s) URL, `host:port`, for matching a tab to the app a request names. */
const hostOf = (url: string): string | undefined => {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
};
const URLS_IN_TEXT = /https?:\/\/[^\s"'<>,]+/gi;

/**
 * The tab a chat-requested drive should use: one whose address the request names, then a visible
 * one over a hidden (throttled) one, then the one heard from most recently.
 */
export function pickDriveSession(
  tabs: readonly DriveCandidate[],
  goal: string,
): string | undefined {
  const named = new Set((goal.match(URLS_IN_TEXT) ?? []).flatMap((url) => hostOf(url) ?? []));
  const rank = (tab: DriveCandidate): number[] => [
    named.has(hostOf(tab.url) ?? '') ? 0 : 1,
    tab.hidden ? 1 : 0,
    tab.lastSeenMs,
  ];
  const better = (a: number[], b: number[]): boolean => {
    for (let i = 0; i < a.length; i += 1) {
      const x = a[i] ?? 0;
      const y = b[i] ?? 0;
      if (x !== y) return x < y;
    }
    return false;
  };
  let best: DriveCandidate | undefined;
  for (const tab of tabs) if (best === undefined || better(rank(tab), rank(best))) best = tab;
  return best?.sessionId;
}

/**
 * The verdict on a drive's goal: the platform's judgement of the goal when it made one, else the
 * goals the harness checked itself. A drive that broke, proved nothing, or whose goal nobody judged
 * is `unknown`: "it ran and nothing threw" is not "the goal was reached".
 */
export function driveVerdict(out: {
  goalMet?: boolean;
  proved: boolean;
  error?: string;
  goals?: readonly { verified: string }[];
  /** How the drive's checks came out. `proved` only says one RAN; this says what each answered. */
  checks?: { held: number; failed: number; undecided: number };
}): DriveVerdict {
  if (out.error !== undefined) return 'unknown';
  // A goal judged unmet, or a check that came back "no", is a failed drive whatever else held.
  if (false === out.goalMet) return 'no';
  if (0 < (out.checks?.failed ?? 0)) return 'no';
  // The quoted texts are looked for on the page the drive ENDED on. None there refutes the goal;
  // some missing does not, because a goal that quotes where it starts ("from "Count is 0" to
  // "Count is 1"") loses that text by working. Then the goal's own judgement decides, as below.
  const goals = out.goals ?? [];
  if (0 < goals.length && goals.every((g) => 'no' === g.verified)) return 'no';
  if (0 < goals.length && !goals.some((g) => 'yes' === g.verified)) return 'unknown';
  // A yes needs a check that held behind it: the model saying the goal was met is not evidence.
  if (!out.proved || 0 === (out.checks?.held ?? 0)) return 'unknown';
  if (true === out.goalMet) return 'yes';
  if (0 < goals.length && goals.every((g) => 'yes' === g.verified)) return 'yes';
  return 'unknown';
}
