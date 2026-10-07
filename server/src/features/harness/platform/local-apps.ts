/**
 * The apps this machine has connected, told to the platform so its chat can list them by name.
 *
 * The chat used to ask for a `localhost` address, and an address names nothing: two projects on
 * `localhost:3000` are one address, and one project restarted on another port is two. So an app here
 * is a project checkout on a machine, keyed by a hash of both, and its address is only where it was
 * last open. Neither the project's path nor the home directory leaves the machine, only their hash.
 *
 * Every few seconds, with or without an app open, each linked project's credential reports its apps.
 * The answer can name apps somebody asked to bring back (opened here, headless) and say a drive is
 * waiting, which is how a daemon with nothing open hears about one without polling every few seconds.
 */
import { createHash } from 'node:crypto';
import {
  LinkPath,
  PLATFORM_LINK_VERSION,
  RETICLE_URL_PARAM,
  type LinkCapability,
} from '@reticlehq/core';
import { pickDriveSession, type DriveCandidate } from './remote-drive.js';

/** How often apps are reported. The platform counts an app live for two and a half of these. */
export const LOCAL_APPS_REPORT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** How long a drive waits for an app it opened to connect before it is refused. */
export const APP_OPEN_WAIT_MS = 20_000;
const APP_OPEN_POLL_MS = 250;
const KEY_LENGTH = 16;
/** The shell a plain browser tab reports: not worth a word on a card that says what it is built with. */
const WEB_RUNTIME = 'web';

export interface Platform {
  url: string;
  apiKey: string;
}

export interface Machine {
  id: string;
  name: string;
}

/** One connected tab, as far as reporting and picking go. */
export interface AppTab extends DriveCandidate {
  title?: string;
  projectId?: string;
  adapters: string[];
  runtime?: string;
}

export interface ReportedApp {
  key: string;
  name: string;
  url: string;
  title?: string;
  stack: string[];
}

const hash = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, KEY_LENGTH);

/** This machine: a stable id that is not its home path, and the name a person knows it by. */
export const machineOf = (hostname: string, home: string): Machine => ({
  id: hash(`${hostname}\u0000${home}`),
  name: hostname.replace(/\.local$/i, ''),
});

/**
 * One project checkout on one machine. Its port is not part of it. The tab's projectId is: a daemon
 * that cannot map a project to its checkout files every such project under one shared directory.
 */
export const appKeyOf = (
  machineId: string,
  projectDir: string,
  projectId: string | undefined,
): string => hash(`${machineId}\u0000${projectDir}\u0000${projectId ?? ''}`);

/** A project id as a name: the SDK stamps `<package>-<8 hex>`, and the hash means nothing to a person. */
export const nameFromProjectId = (projectId: string): string =>
  projectId.replace(/-[0-9a-f]{8}$/, '');

const RETICLE_MARKS = new Set<string>(Object.values(RETICLE_URL_PARAM));

/** The address as the app knows it: the params Reticle put on it to adopt a tab are not the app's. */
const withoutMarks = (raw: string): string => {
  try {
    const url = new URL(raw);
    for (const mark of [...url.searchParams.keys()])
      if (RETICLE_MARKS.has(mark)) url.searchParams.delete(mark);
    return url.href;
  } catch {
    return raw;
  }
};

/**
 * The apps to report, grouped by the platform credential each one's project is linked with. The
 * linked credential is reported even with no app open: it is how the chat knows the machine is there
 * to open one. A tab whose project is not linked is left out: no chat can drive it.
 */
export async function appsByPlatform(
  tabs: readonly AppTab[],
  linked: Platform | undefined,
  machineId: string,
  describe: (tab: AppTab) => Promise<{ platform?: Platform; dir: string; name: string }>,
): Promise<{ platform: Platform; apps: ReportedApp[] }[]> {
  const groups = new Map<string, { platform: Platform; apps: Map<string, ReportedApp> }>();
  const group = (platform: Platform) => {
    const id = `${platform.url}\u0000${platform.apiKey}`;
    const found = groups.get(id) ?? { platform, apps: new Map<string, ReportedApp>() };
    groups.set(id, found);
    return found;
  };
  if (undefined !== linked) group(linked);
  // A visible tab speaks for its project over a hidden one.
  const ordered = [...tabs].sort((a, b) => Number(a.hidden) - Number(b.hidden));
  for (const tab of ordered) {
    const about = await describe(tab).catch(() => undefined);
    if (undefined === about?.platform) continue;
    const key = appKeyOf(machineId, about.dir, tab.projectId);
    const apps = group(about.platform).apps;
    if (apps.has(key)) continue;
    const stack = [
      ...new Set([...tab.adapters, ...(tab.runtime === undefined ? [] : [tab.runtime])]),
    ].filter((part) => WEB_RUNTIME !== part);
    apps.set(key, {
      key,
      name: about.name,
      url: withoutMarks(tab.url),
      ...(tab.title === undefined ? {} : { title: tab.title }),
      stack,
    });
  }
  return [...groups.values()].map(({ platform, apps }) => ({ platform, apps: [...apps.values()] }));
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface AppReportDeps {
  machine: Machine;
  version: string;
  /** What this daemon can do for the platform: it offers a person only what is here. */
  capabilities: readonly LinkCapability[];
  apps: () => Promise<{ platform: Platform; apps: ReportedApp[] }[]>;
  /** Open an app so it connects: one somebody asked to bring back. A throw is logged, never fatal. */
  open: (url: string) => Promise<void>;
  /** A drive is waiting for the project this credential is for. */
  drivePending: (platform: Platform) => void;
  fetch?: FetchLike;
  intervalMs?: number;
  log?: (line: string) => void;
}

export interface AppReports {
  tick: () => Promise<void>;
  stop: () => void;
}

export function startAppReports(deps: AppReportDeps): AppReports {
  const doFetch: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  let busy = false;
  const tick = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      for (const { platform, apps } of await deps.apps()) {
        try {
          const res = await doFetch(`${platform.url}${LinkPath.APPS}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${platform.apiKey}`,
            },
            body: JSON.stringify({
              machine: deps.machine,
              reticleVersion: deps.version,
              protocol: PLATFORM_LINK_VERSION,
              capabilities: deps.capabilities,
              apps,
            }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          if (!res.ok) continue;
          const answer = (await res.json()) as { wake?: unknown; pendingDrive?: unknown };
          const open = new Set(apps.map((app) => app.key));
          for (const wake of Array.isArray(answer.wake) ? answer.wake : []) {
            const { key, url } = (wake ?? {}) as { key?: unknown; url?: unknown };
            if ('string' !== typeof key || 'string' !== typeof url || open.has(key)) continue;
            open.add(key);
            deps.log?.(`reticle: opening ${url}, asked for from the platform chat`);
            await deps.open(url).catch((error: unknown) => {
              deps.log?.(`reticle: could not open ${url}: ${String(error)}`);
            });
          }
          if (true === answer.pendingDrive) deps.drivePending(platform);
        } catch {
          // Offline, or the platform is down: the next report tries again.
        }
      }
    } catch {
      // The credentials could not be read: nothing to report this time.
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), deps.intervalMs ?? LOCAL_APPS_REPORT_MS);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}

/**
 * The tab a drive the chat attached to one app uses: a tab of that app and no other, even on the
 * same port. None open: open the app, and wait for it to connect. Null when it never does.
 */
export async function pickAppTab(
  app: { key: string; url: string | null },
  goal: string,
  tabs: () => readonly AppTab[],
  keyOf: (sessionId: string) => string | undefined,
  open: (url: string) => Promise<void>,
  waitMs = APP_OPEN_WAIT_MS,
): Promise<string | null> {
  const ofApp = (): AppTab[] => tabs().filter((tab) => keyOf(tab.sessionId) === app.key);
  const now = pickDriveSession(ofApp(), goal);
  if (now !== undefined) return now;
  if (null === app.url) return null;
  await open(app.url).catch(() => undefined);
  for (let waited = 0; waited <= waitMs; waited += APP_OPEN_POLL_MS) {
    const opened = pickDriveSession(ofApp(), goal);
    if (opened !== undefined) return opened;
    await new Promise((resolve) => setTimeout(resolve, APP_OPEN_POLL_MS));
  }
  return null;
}
