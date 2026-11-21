/**
 * The one page that a launched drive owns, as `reticle verify` reads it between flows (#2060).
 *
 * A flow can leave the app for a page with no Reticle SDK, for example a server's 404 page. The
 * session of the driven page then drops, and no session connects on that page. To report that and
 * go on with the next flow, the run must know three facts about the page that it drives:
 *
 * - which session is this page's own, so that the run does not take another connected tab (the
 *   user's own tab of the app) for it. The SDK keeps the tab's session id in `sessionStorage`
 *   (`RETICLE_SESSION_STORAGE_KEY`), so the page itself says which session is its own. An SDK
 *   older than 2.5.0 does not write it, and then the page gives no id.
 * - whether the page is a dead end: a positive sign that no session can connect on it.
 * - how to load the start URL again, with the same rules as the first load.
 *
 * "No SDK global yet" is not a dead end. The document leaves `loading` before a module script,
 * a deferred script or a dynamic import has run, so a healthy page of the app has no SDK global
 * for as long as its SDK takes to load (measured on Chromium 1248: 1.9 s with a module script and
 * 1.5 s with a dynamic import, for an SDK sent 1.5 s late). An HTTP error status is not a dead end
 * either: an app's own error page (a Next.js not-found page) can load the SDK in an effect, with
 * import(), after `load`. Only a loaded page on another origin than the start URL's is taken as
 * not a page of the app. Every other page gets the start-page wait (rule 14: accuracy first).
 *
 * In its own file so that `real-input.ts` stays under the line cap.
 */
import type { Page } from 'playwright';
import { z } from 'zod';
import { DriveErrorCode, RETICLE_SESSION_STORAGE_KEY } from '@reticlehq/core';
import { DriveError } from './drive-error.js';
import { stampedDriveUrl } from './drive-url-stamp.js';
import { gotoOptions } from '@/portal/pool/playwright-launcher.js';

/** True on a page whose Reticle SDK has loaded. */
export const SDK_PRESENT = '!!globalThis.__reticleInstance';

/** What the page says about itself. */
const PageFacts = z.object({
  origin: z.string(),
  loaded: z.boolean(),
  sdk: z.boolean(),
});
type PageFacts = z.infer<typeof PageFacts>;

/** Runs in the page. Self-contained: Playwright sends the function source to the page. */
function readPageFacts(): PageFacts {
  const scope = globalThis as unknown as {
    location: { origin: string };
    document: { readyState: string };
    __reticleInstance?: unknown;
  };
  return {
    origin: scope.location.origin,
    loaded: 'complete' === scope.document.readyState,
    sdk: scope.__reticleInstance !== undefined && scope.__reticleInstance !== null,
  };
}

/** The origin of `url`, or undefined when it does not parse. */
function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * A positive sign that no session can connect on this page: it has loaded, it has no SDK, and it
 * is on another origin than the start URL (a site outside the app, or the browser's own error
 * page, whose origin is "null"). A page of the app's own origin is never a dead end, also with an
 * HTTP error status: it can still load its SDK.
 */
function isDeadEnd(facts: PageFacts, startOrigin: string | undefined): boolean {
  if (facts.sdk || !facts.loaded) {
    return false;
  }
  return startOrigin !== undefined && facts.origin !== startOrigin;
}

/** What `reticle verify` reads from, and does to, the page that it drives. */
export interface DrivenPage {
  /** The URL that the page shows now. It can be a page with no session. */
  url(): string;
  /** The session id that the page's SDK keeps for this tab. Undefined when the page has none. */
  sessionId(): Promise<string | undefined>;
  /**
   * True when the SDK global is on the page now, false when it is not there now (it can still
   * load). Undefined when the page cannot be read.
   */
  hasSdk(): Promise<boolean | undefined>;
  /**
   * True only on a positive sign that no session can connect on this page: it has loaded, it has
   * no SDK, and it is on another origin. False on a page that can still load its SDK (any page of
   * the app's own origin), and on a page that cannot be read.
   */
  deadEnd(): Promise<boolean>;
  /** Load the start URL again in the same page. True when the page loaded. */
  reopen(): Promise<boolean>;
}

/**
 * Load the drive URL in `page`. Throws a DriveError when the load fails.
 *
 * Same navigation rule as the pool, and for the same measured reason: Playwright's default waits
 * for `load`, which an app with one never-finishing subresource never fires — 30s of nothing and
 * then a failure that blames the app. The SDK connect is a module script, so it has already run by
 * DOMContentLoaded. See gotoOptions.
 *
 * Stamped, so the page can tell Reticle opened it — see drive-url-stamp.ts. Without it the
 * first-run tour mounts over a driven page and its scrim swallows every native gesture.
 */
export async function gotoDriveUrl(page: Page, driveUrl: string): Promise<void> {
  try {
    await page.goto(stampedDriveUrl(driveUrl), gotoOptions(undefined));
  } catch (e) {
    throw new DriveError(
      DriveErrorCode.NAVIGATE_FAILED,
      e instanceof Error ? e.message : String(e),
    );
  }
}

/** Runs in the page. Self-contained: Playwright sends the function source to the page. */
function readTabSession(key: string): string | null {
  try {
    const store = (globalThis as { sessionStorage?: { getItem(k: string): string | null } })
      .sessionStorage;
    return store?.getItem(key) ?? null;
  } catch {
    // A page that refuses storage access has no session id to give.
    return null;
  }
}

/**
 * The driven page `page`, opened at `driveUrl`. `reload` loads the start URL again with the same
 * rules as the first load, and throws when the load fails.
 */
export function drivenPageOf(
  page: Page,
  driveUrl: string,
  reload: () => Promise<void>,
): DrivenPage {
  return {
    url: () => page.url(),
    sessionId: async () => {
      const id = await page.evaluate(readTabSession, RETICLE_SESSION_STORAGE_KEY).catch(() => null);
      return 'string' === typeof id && 0 < id.length ? id : undefined;
    },
    hasSdk: async () => {
      // A page in the middle of a navigation cannot be read. That is not a page without the SDK.
      const state: unknown = await page.evaluate(SDK_PRESENT).catch(() => null);
      return 'boolean' === typeof state ? state : undefined;
    },
    deadEnd: async () => {
      const facts = PageFacts.safeParse(await page.evaluate(readPageFacts).catch(() => null));
      return facts.success && isDeadEnd(facts.data, originOf(driveUrl));
    },
    reopen: () =>
      reload().then(
        () => true,
        () => false,
      ),
  };
}
