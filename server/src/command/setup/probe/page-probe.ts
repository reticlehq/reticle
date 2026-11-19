/**
 * The one thing the daemon cannot know: what the page actually contains.
 *
 * `diagnoseNoSession` in session/no-session-diagnosis.ts already tells the four daemon-side cases
 * apart — a session that came and went, something listening that never dialled, a wired project on
 * the wrong port, nothing listening at all — and its sentence is the one to lead with. None of that
 * requires fetching anything, which is also its limit: the daemon never sees the HTML.
 *
 * So this adds only the page-side fact and nothing else. Whether the SDK is IN what the server
 * returned splits the most common failure of all — a dev server still serving the bundle it built
 * before the build config was edited — from a connect that ran and returned early.
 */

/** What a single fetch of the app's url established. */
export interface PageProbe {
  /** The server answered at all. */
  readonly served: boolean;
  /** The SDK is referenced in what it answered with. A reference, not proof that the SDK loaded. */
  readonly sdkInPage: boolean;
  /**
   * The server ANSWERED and its certificate was refused. A self-signed dev cert is an ordinary
   * local setup, so treating this as "nothing is listening" tells someone to start a server that is
   * already running.
   */
  readonly tlsRefused?: boolean | undefined;
  /**
   * The URL that actually answered, when the announced host missed and a loopback sibling did not.
   * Callers that open a browser or wait on a session should prefer this over the announcement (#884).
   */
  readonly reachedUrl?: string | undefined;
  /**
   * The answer was an HTML page (`text/html`, or a body that opens with `<!doctype` or `<html`).
   * An API answers with JSON: a root `dev` script that starts the app and an API announces both, and
   * only the HTML one is the app. Absent from a probe that did not read it.
   */
  readonly html?: boolean | undefined;
}

export const PageFinding = {
  NOT_SERVED: 'not-served',
  TLS_REFUSED: 'tls-refused',
  SDK_MISSING: 'sdk-missing',
  SDK_PRESENT: 'sdk-present',
} as const;
export type PageFinding = (typeof PageFinding)[keyof typeof PageFinding];

/** Where a reference that never loaded shows itself. Shared by both SDK_PRESENT sentences. */
const FAILED_IMPORT =
  'open the browser console and look for a failed import of @reticlehq/browser: a CDN 404 (for ' +
  'example a version that is not published yet, or a private registry), a blocked script, or a ' +
  'wrong path.';

/** Pure, so the mapping is testable without a server or a browser. */
export function readPage(probe: PageProbe): PageFinding {
  if (true === probe.tlsRefused) return PageFinding.TLS_REFUSED;
  if (!probe.served) return PageFinding.NOT_SERVED;
  return probe.sdkInPage ? PageFinding.SDK_PRESENT : PageFinding.SDK_MISSING;
}

/**
 * What the page adds to the daemon's account. Deliberately a sentence to APPEND, not a replacement:
 * the daemon's diagnosis names the fix, and this says what the page looked like when we checked.
 *
 * `daemonSpoke`: the daemon already gave its account. Whether the page dialled is ITS fact (it
 * sees every hello, including one it refused), so the SDK_PRESENT sentence then states only the
 * page fact. Saying "never dialled the bridge" under "this daemon REFUSED the last page" contradicted
 * the one piece of positive evidence in the run.
 */
export function describePage(finding: PageFinding, url: string, daemonSpoke = false): string {
  // The probe reads the HTML text. It sees a REFERENCE to the SDK, not an SDK that loaded: a
  // pinned CDN version that returns 404 leaves the reference in place and no SDK in the page.
  if (PageFinding.SDK_PRESENT === finding && daemonSpoke) {
    return (
      `The page at ${url} references the SDK. That does not prove the SDK loaded: the daemon's ` +
      `account above says if an SDK session dialled. If none did, ${FAILED_IMPORT}`
    );
  }
  switch (finding) {
    case PageFinding.NOT_SERVED:
      // Leads with the cause. The break-matrix asserts this phrasing because it is what a reader
      // greps for after a timeout, and "nothing answered" reads as an observation about the check
      // rather than a statement about the machine.
      return `nothing is serving ${url} — the dev server is not up, so the SDK was never given the chance to load.`;
    case PageFinding.TLS_REFUSED:
      return (
        `${url} answered over HTTPS with a certificate this process will not accept, so setup could ` +
        'not read the page. The app itself may be perfectly fine; re-run with ' +
        'NODE_TLS_REJECT_UNAUTHORIZED=0 if you trust this dev certificate, or use the http origin.'
      );
    case PageFinding.SDK_MISSING:
      return (
        `${url} is served, and the SDK is NOT in the page. That is almost always a dev server still ` +
        'serving the bundle it built before the build config was edited: restart it and hard-reload.'
      );
    case PageFinding.SDK_PRESENT:
      // This used to end "so it loaded and returned early", which is a claim about a code path this
      // check cannot see — and at least one real occurrence was the opposite. On a Windows install
      // gate cell the page console read "could not open a websocket to ws://localhost:<port>, 3
      // attempts, all failed": the SDK dialled three times and the socket failed, having returned
      // early from nothing. What is knowable here is that the SDK is present and no session arrived.
      return (
        `The page at ${url} references the SDK, and the SDK never dialled the bridge. First, ` +
        `${FAILED_IMPORT} If the import loaded, the cause is a localhost guard, a ` +
        'production-only check, a bridge port that differs on the two sides, or `localhost` ' +
        'resolving to IPv6 where the daemon is only on IPv4. `npx @reticlehq/server doctor` names ' +
        'that last one, and the page console names the first three.'
      );
  }
}

/**
 * What the page looks like once it has had its short chance to come up.
 *
 * The wait before opening a browser used to retry on `SDK_MISSING` and on nothing else, so a
 * first probe of `NOT_SERVED` left the loop at once and the window was refused on ONE sample.
 * That refusal is right for a url that will never answer and wrong for one that is still
 * starting, and the two are identical at the first probe.
 *
 * Measured on the install gate's Nuxt scaffold: "nothing is serving" and "Not opening a
 * browser", then two lines later "http://localhost:3000/ is served". The dev server came up
 * during the phase, the window was never opened, no session could appear, and `init` exited 1
 * on a correct install. Nothing about it is Nuxt-specific; it is the slowest scaffold here and
 * any cold start slower than the first probe loses the same race.
 *
 * So both unfinished states wait: NOT_SERVED because the server may still be starting, and
 * SDK_MISSING because the bundle may still be arriving. Whatever is true when the window closes
 * is the answer, and a url that never answers is still refused -- by then it has been asked
 * repeatedly rather than once.
 *
 * A function rather than a loop inside `runSetupPhases`, because the caller polls the same
 * `probePage` 1,500 times before reaching this point and a test of the decision cannot get near
 * it through that. Here it takes a probe and a clock and answers in three lines of setup.
 */
export async function findingBeforeOpen(
  probe: () => Promise<PageProbe>,
  clock: { readonly now: () => number; readonly sleep: (ms: number) => Promise<void> },
  windowMs: number,
  pollMs: number,
  /**
   * The served HTML carries the SDK marker on this shape. When it does not (the connect is in the
   * JS bundle), SDK_MISSING is the permanent state of a healthy page, and waiting for it to change
   * only delays the window that would load the bundle.
   */
  htmlCarriesSdk = true,
): Promise<PageFinding> {
  const readyBy = clock.now() + windowMs;
  let finding = readPage(await probe());
  while (
    ((htmlCarriesSdk && PageFinding.SDK_MISSING === finding) ||
      PageFinding.NOT_SERVED === finding) &&
    clock.now() < readyBy
  ) {
    await clock.sleep(pollMs);
    finding = readPage(await probe());
  }
  return finding;
}
