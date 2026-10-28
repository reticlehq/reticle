/**
 * Bare `reticle` in a folder that Reticle has not wired: the first verdict, with no agent, no
 * `init` and no model.
 *
 * It finds the app (the folder's own dev server, or the one dev server that runs on this computer),
 * starts the dev server when it does not run, opens the page in a Reticle browser with the
 * zero-install reader, and runs a smoke check that cannot guess: the page loads, no console error,
 * no failed request, and each same-origin link opens. Then it prints the verdict and the next step.
 *
 * The decisions are here, behind `FirstVerdictPorts`, so each one is a unit test. The browser, the
 * daemon and the dev server are in `first-verdict-node.ts`.
 */
import { CRAWL_DEFAULTS, EventType, NetInitiator, type ReticleEvent } from '@reticlehq/core';
import { OnboardingStop } from '@reticlehq/core/telemetry';
import { isAuthPath } from '@/surface/tools/lease-seed.js';

/** Bare `reticle` runs the first verdict only with no arguments, in a folder with no Reticle config. */
export function bareRunsFirstVerdict(argv: readonly string[], wired: boolean): boolean {
  return 0 === argv.length && !wired;
}

const LOCALHOST = 'http://localhost';
const localUrl = (port: number): string => `${LOCALHOST}:${String(port)}`;

export const AppChoice = {
  /** Check this url. */
  USE: 'use',
  /** Start the folder's dev command, then check what it serves. */
  START: 'start',
  /** Nothing to check: say why. */
  NONE: 'none',
} as const;

export type AppDecision =
  | { action: typeof AppChoice.USE; url: string }
  | { action: typeof AppChoice.START }
  | { action: typeof AppChoice.NONE; lines: string[]; stop: OnboardingStop };

export const MSG_NO_APP = [
  'Reticle found no web app here, and no dev server that runs on this computer.',
  'Run this command in the folder of your web app, or start its dev server first.',
];

/**
 * Which app to check. In an app folder, only that app: a server on another port can be another
 * app, and a verdict on the wrong app is worse than none. Outside one, the one server that runs.
 */
export function chooseApp(facts: {
  /** The folder's dev command, when the folder holds a web app. */
  devCommand?: { port?: number };
  /** The dev command pins a port, and that port serves a page now. */
  pinnedServing: boolean;
  /** Dev-server ports that serve a page now, outside Reticle's own. */
  running: readonly number[];
}): AppDecision {
  if (facts.devCommand !== undefined) {
    const pinned = facts.devCommand.port;
    if (pinned !== undefined && facts.pinnedServing) {
      return { action: AppChoice.USE, url: localUrl(pinned) };
    }
    return { action: AppChoice.START };
  }
  const [only, ...others] = facts.running;
  if (only !== undefined && 0 === others.length) {
    return { action: AppChoice.USE, url: localUrl(only) };
  }
  if (only !== undefined) {
    return {
      action: AppChoice.NONE,
      stop: OnboardingStop.NO_WEB_APP,
      lines: [
        'Reticle found more than one dev server, so it did not choose one:',
        ...facts.running.map((port) => `  ${localUrl(port)}`),
        'Run this command in the folder of the app to check.',
      ],
    };
  }
  return { action: AppChoice.NONE, stop: OnboardingStop.NO_WEB_APP, lines: MSG_NO_APP };
}

/** What one page did, read from its own document's events. */
export interface PageFacts {
  /** The url the check opened. */
  url: string;
  /** The page came back with Reticle connected, at the url asked for. */
  arrived: boolean;
  /** Where the page went instead, when it went somewhere else. */
  landedOn?: string;
  /** The HTTP status of the document, when the browser reported one. */
  documentStatus?: number;
  consoleErrors: string[];
  failedRequests: string[];
}

const ABORTED = /abort/i;
const text = (value: unknown): string | undefined =>
  'string' === typeof value ? value : undefined;
const num = (value: unknown): number | undefined => ('number' === typeof value ? value : undefined);

/** A request that failed: an error status, or no answer that the page did not cancel itself. */
function failure(e: ReticleEvent): string | undefined {
  if (EventType.NET_REQUEST !== e.type || NetInitiator.DOCUMENT === e.data['initiator']) {
    return undefined;
  }
  const where = `${text(e.data['method']) ?? 'GET'} ${text(e.data['url']) ?? ''}`;
  const status = num(e.data['status']);
  if (status !== undefined && status >= CRAWL_DEFAULTS.FAILED_STATUS) {
    return `${where}: HTTP ${String(status)}`;
  }
  const error = text(e.data['error']);
  if (0 === status && error !== undefined && !ABORTED.test(error)) {
    return `${where}: ${error}`;
  }
  return undefined;
}

/**
 * The facts of the page now on screen. Events of an earlier document are left out: the check
 * reloads each page, and what the old document did is not this page's fault.
 */
export function pageFactsOf(
  url: string,
  events: readonly ReticleEvent[],
  nav: { arrived: boolean; landedOn?: string },
): PageFacts {
  const loads = events.filter(
    (e) => EventType.NET_REQUEST === e.type && NetInitiator.DOCUMENT === e.data['initiator'],
  );
  const load = loads.at(-1);
  const documentId = load?.documentId ?? events.at(-1)?.documentId;
  const current = events.filter(
    (e) => documentId === undefined || e.documentId === undefined || e.documentId === documentId,
  );
  const documentStatus = num(load?.data['status']);
  return {
    url,
    arrived: nav.arrived,
    ...(nav.landedOn === undefined ? {} : { landedOn: nav.landedOn }),
    ...(documentStatus === undefined ? {} : { documentStatus }),
    consoleErrors: current
      .filter((e) => EventType.CONSOLE_ERROR === e.type || EventType.ERROR_UNCAUGHT === e.type)
      .map((e) => text(e.data['message']) ?? e.type),
    failedRequests: current.flatMap((e) => {
      const failed = failure(e);
      return failed === undefined ? [] : [failed];
    }),
  };
}

/**
 * A link that ends the signed-in session. Opening it would check the rest of the app signed out.
 * ponytail: the same words the crawl leaves alone; `cli` does not reach `crawl`, so it is said here.
 */
const ENDS_SESSION = /\b(?:sign ?out|log ?out|sign ?off|log ?off)\b/i;

/** The most links one check opens. Each one is a page load. */
export const MAX_LINKS_OPENED = 8;
const WEB_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * The same-origin pages the links on `pageUrl` lead to, once each, without the page itself and
 * without a link that ends the session. `found` counts them all, so a capped list says so.
 */
export function linksToOpen(
  pageUrl: string,
  links: readonly { name: string; href: string }[],
  max: number = MAX_LINKS_OPENED,
): { open: string[]; found: number } {
  const here = new URL(pageUrl);
  const key = (u: URL): string => `${u.pathname.replace(/\/+$/, '')}${u.search}`;
  const seen = new Set<string>([key(here)]);
  const pages: string[] = [];
  for (const link of links) {
    let target: URL;
    try {
      target = new URL(link.href, here);
    } catch {
      continue;
    }
    if (!WEB_PROTOCOLS.has(target.protocol) || target.origin !== here.origin) {
      continue;
    }
    if (ENDS_SESSION.test(link.name) || ENDS_SESSION.test(target.pathname.replace(/[/-]/g, ' '))) {
      continue;
    }
    if (seen.has(key(target))) {
      continue;
    }
    seen.add(key(target));
    target.hash = '';
    pages.push(target.href);
  }
  return { open: pages.slice(0, max), found: pages.length };
}

/** What the smoke check saw: the start page, and each link it opened. */
export interface SmokeFacts {
  start: PageFacts;
  links: PageFacts[];
  /** Same-origin links found on the start page. More than `links` when the check opened fewer. */
  linksFound: number;
}

export interface SmokeVerdict {
  verified: 'yes' | 'no';
  lines: string[];
}

const PASS = '  ✓';
const FAIL = '  ✗';
const NOTE = '  -';

const pathOf = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
};

/** Why a page did not load, or undefined when it loaded. */
function notLoaded(page: PageFacts): string | undefined {
  // A page that went somewhere else (a redirect to a dashboard, or to sign in) did open.
  if (!page.arrived && page.landedOn === undefined) {
    return 'it did not load, or Reticle could not connect to it';
  }
  if (page.documentStatus !== undefined && page.documentStatus >= CRAWL_DEFAULTS.FAILED_STATUS) {
    return `the server answered HTTP ${String(page.documentStatus)}`;
  }
  return undefined;
}

/** The faults of one page, one line each. */
function faultsOf(page: PageFacts, label: string): string[] {
  const missed = notLoaded(page);
  return [
    ...(missed === undefined ? [] : [`${FAIL} ${label} did not open: ${missed}.`]),
    ...page.consoleErrors.map((message) => `${FAIL} Console error on ${label}: ${message}`),
    ...page.failedRequests.map((request) => `${FAIL} Failed request on ${label}: ${request}`),
  ];
}

/**
 * The verdict. "yes" only when the start page loaded with no console error and no failed request,
 * and every link it opened did the same. A page that sends a visitor to sign in is a verdict too:
 * the check is "yes" up to there, and it says what it could not reach.
 */
export function judgeSmoke(facts: SmokeFacts): SmokeVerdict {
  const start = facts.start;
  const landed = start.landedOn === undefined ? undefined : new URL(start.landedOn);
  const signIn =
    landed !== undefined && isAuthPath(landed.pathname) && !isAuthPath(new URL(start.url).pathname);
  const faults = [
    ...faultsOf(start, pathOf(start.url)),
    ...facts.links.flatMap((link) => faultsOf(link, pathOf(link.url))),
  ];
  const lines: string[] = [];
  if (signIn && landed !== undefined) {
    lines.push(
      `${NOTE} The app sent the page to its sign-in page (${landed.pathname}). ` +
        'Reticle verified up to here. It did not check the pages behind sign-in.',
    );
  }
  const linksOk = facts.links.filter((link) => 0 === faultsOf(link, '').length).length;
  if (0 === faults.length) {
    lines.push(
      `${PASS} The page loads.`,
      `${PASS} No console error.`,
      `${PASS} No failed request.`,
    );
  }
  lines.push(...faults);
  if (0 === facts.linksFound) {
    lines.push(`${NOTE} The page has no same-origin link, so no link was opened.`);
  } else {
    lines.push(
      `${0 === faults.length ? PASS : NOTE} ${String(linksOk)} of ${String(facts.links.length)} ` +
        `link(s) opened with no fault.`,
    );
  }
  if (facts.links.length < facts.linksFound) {
    lines.push(
      `${NOTE} Reticle opened ${String(facts.links.length)} of ${String(facts.linksFound)} ` +
        'same-origin links. It did not check the others.',
    );
  }
  const verified = 0 === faults.length ? 'yes' : 'no';
  lines.push(
    'yes' === verified
      ? `verified: yes — the smoke check passed on ${start.url}`
      : `verified: no — ${String(faults.length)} fault(s) on ${start.url}`,
  );
  return { verified, lines };
}

/** The app to check, or why there is none. `release` stops a dev server this run started. */
export type FoundApp =
  { url: string; release?: () => void } | { lines: string[]; stop: OnboardingStop };

export interface FirstVerdictPorts {
  findApp: () => Promise<FoundApp>;
  /** Open the page with the zero-install reader and collect the facts, or say why it could not. */
  smoke: (url: string) => Promise<SmokeFacts | { failed: string[] }>;
  out: (line: string) => void;
  /** Record one onboarding stop. */
  stop: (row: { step: string; stop: OnboardingStop }) => void;
}

export const MSG_NEXT_STEP = [
  'Next: connect your coding agent, so it can verify each change it makes:',
  '  npx @reticlehq/server init',
];

const STEP_PROJECT_DETECTED = 'project_detected';
const STEP_APP_CONNECTED = 'app_connected';
const EXIT_OK = 0;
const EXIT_FAIL = 1;

/** Find the app, check it, print the verdict. Returns the exit code: 0 only for "verified: yes". */
export async function runFirstVerdict(ports: FirstVerdictPorts): Promise<number> {
  const found = await ports.findApp();
  if ('stop' in found) {
    for (const line of found.lines) {
      ports.out(line);
    }
    const step =
      OnboardingStop.NO_WEB_APP === found.stop ? STEP_PROJECT_DETECTED : STEP_APP_CONNECTED;
    ports.stop({ step, stop: found.stop });
    return EXIT_FAIL;
  }
  try {
    ports.out(`Reticle is checking ${found.url}. It installs nothing in your app.`);
    let facts: SmokeFacts | { failed: string[] };
    try {
      facts = await ports.smoke(found.url);
    } catch (error) {
      facts = { failed: [error instanceof Error ? error.message : String(error)] };
    }
    if ('failed' in facts) {
      for (const line of [
        'verified: unknown — Reticle could not check the page:',
        ...facts.failed,
      ]) {
        ports.out(line);
      }
      ports.stop({ step: STEP_APP_CONNECTED, stop: OnboardingStop.APP_NOT_CONNECTED });
      return EXIT_FAIL;
    }
    const verdict = judgeSmoke(facts);
    for (const line of [...verdict.lines, '', ...MSG_NEXT_STEP]) {
      ports.out(line);
    }
    return 'yes' === verdict.verified ? EXIT_OK : EXIT_FAIL;
  } finally {
    found.release?.();
  }
}

/** The `reason` on a stop this command records, so a reader can tell it from an `init` stop. */
export const FIRST_VERDICT_REASON = 'first_verdict';
