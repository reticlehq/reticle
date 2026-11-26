/**
 * A tab that is open in the person's own browser, joined to this daemon as a session.
 *
 * `reticle drive` opens a tab of its own in an isolated context, signed in to nothing. The tabs the
 * person has open (their mail, a cloud console) were out of reach, and an agent had to read them
 * from the outside, through the operating system, with no network, no state and no click that the
 * page takes. This joins such a tab: over the browser's debugging port (a Chromium browser started
 * with --remote-debugging-port), the page's security policy is set aside for this connection only,
 * the tab is reloaded, and the zero-install reader is put in it. The reader dials the daemon as any
 * page does, with a pass minted for the tab's origin.
 *
 * The connection is kept for the life of the daemon: the reader is put in again on each load of
 * the tab, and the security policy stays set aside, only while it is held.
 */
import { LOCAL_NETWORK_ACCESS, offLoopbackOrigin } from './context-permissions.js';
import { injectReaderInto } from './zero-install.js';

/** A tab as the attach needs it: a Playwright page, or a test fake of one. */
export interface AttachablePage {
  url(): string;
  title(): Promise<string>;
  reload(options?: { waitUntil?: 'domcontentloaded' }): Promise<unknown>;
  addInitScript(script: string): Promise<unknown>;
  evaluate(script: string): Promise<unknown>;
  context(): {
    newCDPSession(
      page: never,
    ): Promise<{ send(method: string, params?: object): Promise<unknown> }>;
    grantPermissions?:
      ((permissions: string[], options: { origin: string }) => Promise<void>) | undefined;
  };
}

/** A browser as the attach needs it. */
export interface AttachableBrowser {
  contexts(): { pages(): AttachablePage[] }[];
  /** For a browser joined over its debugging port: closes the connection, not the browser. */
  close?(): Promise<void>;
}

type CdpSession = { send(method: string, params?: object): Promise<unknown> };

export interface AttachTabOptions {
  /** The debugging address of the browser, such as http://127.0.0.1:9222. */
  cdpUrl: string;
  /** Words that the address of the one tab holds. */
  match: string;
  /** The reader for a page at this address, with its pass. Undefined: this install has none. */
  scriptFor: (url: string) => string | undefined;
  connect?: (cdpUrl: string) => Promise<AttachableBrowser>;
}

/** The origins of the tabs, for a refusal: a path can hold a private word, an origin does not. */
function originsOf(tabs: readonly { url(): string }[]): string {
  const origins = tabs.map((t) => {
    try {
      return new URL(t.url()).origin;
    } catch {
      return 'a tab with no web address';
    }
  });
  return [...new Set(origins)].join(', ') || 'none';
}

/**
 * Hosts never joined, whatever the caller asks: password vaults and sign-in pages. Their content is
 * the person's secrets, and the attach sets the page's security policy aside for its connection.
 */
const NEVER_JOINED: readonly RegExp[] = [
  /(^|\.)bitwarden\.com$/,
  /(^|\.)1password\.(com|eu|ca)$/,
  /(^|\.)lastpass\.com$/,
  /(^|\.)dashlane\.com$/,
  /(^|\.)keepersecurity\.(com|eu)$/,
  /^accounts\.google\.com$/,
  /^login\.microsoftonline\.com$/,
  /^signin\.aws\.amazon\.com$/,
];

function neverJoined(url: string): boolean {
  if (!URL.canParse(url)) {
    return false;
  }
  const host = new URL(url).hostname;
  return NEVER_JOINED.some((pattern) => pattern.test(host));
}

/** The one tab whose address holds `match`, or why there is not one. */
export function pickTab<T extends { url(): string }>(
  tabs: readonly T[],
  match: string,
): { tab: T } | { error: string } {
  const found = tabs.filter((t) => t.url().includes(match));
  if (found.some((t) => neverJoined(t.url()))) {
    return {
      error:
        "Reticle never joins a password vault or a sign-in page: its content is the person's secrets. Join the tab of the task.",
    };
  }
  if (1 === found.length && found[0] !== undefined) {
    return { tab: found[0] };
  }
  if (0 === found.length) {
    return {
      error: `no open tab has "${match}" in its address. The tabs open come from: ${originsOf(tabs)}.`,
    };
  }
  return {
    error: `${String(found.length)} tabs have "${match}" in their address. Give more of the address, so that one tab has it.`,
  };
}

const connectOverCdp = async (cdpUrl: string): Promise<AttachableBrowser> => {
  const { chromium } = await import('playwright');
  return chromium.connectOverCDP(cdpUrl);
};

/** Browsers this daemon holds, by debugging address: one connection for each. */
const held = new Map<string, Promise<AttachableBrowser>>();
/** The tabs joined through each connection, and the browser, so that a detach can undo the join. */
const joined = new Map<string, { browser: AttachableBrowser; sessions: CdpSession[] }>();

/**
 * Undo every join through this debugging address: the page security of each tab is on again, and
 * the connection is closed (the browser and its tabs stay open). Says how many tabs it undid.
 */
export async function detachTabs(cdpUrl: string): Promise<number> {
  const entry = joined.get(cdpUrl);
  joined.delete(cdpUrl);
  held.delete(cdpUrl);
  if (entry === undefined) {
    return 0;
  }
  for (const session of entry.sessions) {
    await session.send('Page.setBypassCSP', { enabled: false }).catch(() => undefined);
  }
  await entry.browser.close?.().catch(() => undefined);
  return entry.sessions.length;
}

/** Join the tab, and say its address and title. Throws when no one tab fits or nothing can run. */
export async function attachTab(opts: AttachTabOptions): Promise<{ url: string; title: string }> {
  let browser = held.get(opts.cdpUrl);
  if (browser === undefined || opts.connect !== undefined) {
    browser = (opts.connect ?? connectOverCdp)(opts.cdpUrl);
    if (opts.connect === undefined) {
      held.set(opts.cdpUrl, browser);
    }
  }
  const opened = await browser;
  const tabs = opened.contexts().flatMap((context) => context.pages());
  const picked = pickTab(tabs, opts.match);
  if ('error' in picked) {
    throw new Error(picked.error);
  }
  const page = picked.tab;
  if (opts.scriptFor(page.url()) === undefined) {
    throw new Error('this install has no zero-install reader to put in the tab');
  }
  // For this connection only: the page's own policy blocks a connection to a local daemon.
  const cdp = await page.context().newCDPSession(page as never);
  await cdp.send('Page.setBypassCSP', { enabled: true });
  const entry = joined.get(opts.cdpUrl) ?? { browser: opened, sessions: [] };
  entry.sessions.push(cdp);
  joined.set(opts.cdpUrl, entry);
  // Chromium blocks a public page from dialling localhost unless Local Network Access is granted:
  // the reader was in the tab and never connected.
  const origin = offLoopbackOrigin(page.url());
  const context = page.context();
  if (origin !== undefined && context.grantPermissions !== undefined) {
    await context.grantPermissions([LOCAL_NETWORK_ACCESS], { origin }).catch(() => undefined);
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await injectReaderInto(page, opts.scriptFor(page.url()));
  return { url: page.url(), title: await page.title() };
}
