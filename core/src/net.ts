/**
 * Network-call vocabulary shared by the browser SDK and the server. Split out of constants.ts to
 * keep that file under the size cap.
 */

/**
 * What issued a network-shaped call. Desktop apps (Electron, Tauri) reach their backend over IPC
 * rather than HTTP, so an IPC call is recorded as a request with `initiator: 'ipc'` — that keeps
 * `reticle_network`, settle-waiting and `assert { net }` working on desktop with no new wire shape.
 */
export const NetInitiator = {
  FETCH: 'fetch',
  XHR: 'xhr',
  BEACON: 'beacon',
  IPC: 'ipc',
  /**
   * The request that fetched the DOCUMENT itself, read once from `PerformanceNavigationTiming`.
   *
   * A server-rendered app answers a click with a full document load: the old document is torn down
   * with the SDK inside it, and the SDK comes back up in a page whose defining request happened
   * before it existed. No patched transport could have seen it, so the net channel had no record of
   * it at all — a Django MPA click was verified on route and heading while the `net` clause naming
   * the destination MISSED, and the verdict came back `unknown`.
   *
   * DISTINCT FROM the document-INITIATED subresource initiators (`link`, `css`, `img`, `script`,
   * `manifest`, `other`) that the resource-timing observer stamps. Those prove that observer is
   * alive on this page and gate a downgrade in `predicate-eval`; this one does not, because the
   * navigation entry exists on every page with Navigation Timing including ones where
   * `PerformanceObserver` never fired. Conflating them would turn an honest "cannot tell" into a
   * false red over favicons and fonts.
   */
  DOCUMENT: 'document',
  /**
   * The browser is LEAVING for this URL, recorded at the moment of departure.
   *
   * Emitted as a NET_PENDING that can never be matched, because that is exactly what it is: a
   * request the browser is about to make and whose outcome this SDK will never see, having died with
   * the document. Absence of a completion is honest here rather than a defect, and `reconcileNet`
   * already renders an unmatched pending as `{status: 'pending'}` — so a `urlContains` assertion
   * matches it and a `status: 200` one correctly does not.
   *
   * It exists because leaving the instrumented origin returned `observation_lost` and nothing else.
   * "Sign in with <provider>" is on a large share of real apps, and the checkable claim is narrow:
   * does the app hand the browser to the expected provider, with the expected parameters? Nobody
   * expects Reticle to verify the provider's own pages. That modest claim came back as `unknown`,
   * and the reporter's fallback was to read the local endpoint's 302 by hand and report the whole
   * flow unverified.
   *
   * The same event covers a native download — an `<a download href="/api/export.pdf">` produces no
   * fetch and no new document, so an export was equally unprovable.
   *
   * MUST be excluded from the settle oracle: a pending that by construction never completes would
   * otherwise mean no page containing an outbound link ever settles again.
   */
  NAVIGATION: 'navigation',
} as const;
export type NetInitiator = (typeof NetInitiator)[keyof typeof NetInitiator];

/**
 * Synthetic URL scheme for an IPC call, so a channel/command name occupies the `url` field the way a
 * real endpoint does: `ipc://get_user`. Agents filter and assert on it with the ordinary net tools.
 */
export const IPC_URL_SCHEME = 'ipc://';

/**
 * IPC has no status code, but every existing filter and assertion in Reticle keys on one
 * (`reticle_network { status: 500 }`, "did POST /x return 200?"). Mapping a settled IPC call onto
 * these two synthetic codes is what makes a FAILED main-process handler or Rust command visible to
 * the tools an agent already uses — without it, an IPC failure is unqueryable and the desktop story
 * is a false green by construction. `ok` is still emitted alongside and is the authoritative field.
 */
export const IpcStatus = {
  OK: 200,
  ERROR: 500,
} as const;

/**
 * `202 Accepted` — the server took the request and has NOT finished processing it.
 *
 * The only status in HTTP whose meaning is "no outcome yet". Folding it into the 2xx success band is
 * how an asynchronous workflow gets verified at exactly the moment nothing has been decided:
 * measured on a logistics console, a dispatch answered 202, the UI rendered success, the page
 * settled, and the server reverted the shipment 1.2s later.
 */
export const HTTP_ACCEPTED = 202;

/**
 * Traffic the DEV TOOLCHAIN makes about itself — never the app under test.
 *
 * A CLOSED list, deliberately. Reported from a real drive: a correct Next.js navigation graded
 * `verified: "no"` because the dev overlay was fetching a source map for an unrelated React key
 * warning (`POST /__nextjs_original-stack-frames`), and that in-flight request counted as "the UI
 * advanced over a request that never settled". Every app that logs one dev warning got a false
 * negative on every action — the worst defect class after a false green.
 *
 * The rule for adding an entry: it must be a channel the FRAMEWORK owns, that no application route
 * can occupy, and that fires as a consequence of running in dev rather than of anything the user
 * did. Widening one of these until it can swallow an app endpoint converts this false negative into
 * a false GREEN, so each pattern is anchored to a reserved prefix or a build-tool file suffix:
 *
 *  - `/__nextjs` — every Next dev-overlay endpoint shares this reserved prefix (`_original-stack-frames`,
 *    `_original-stack-frame`, `_launch-editor`, `_source-map`, `_error_feedback`, `_server_status`,
 *    `_devtools_config`, `_font`, …). Verified against next@15 and next@16 `dist`.
 *  - `/_next/webpack-hmr` + `/_next/static/webpack/` — Next's HMR channel and the `.hot-update.*`
 *    chunks it fetches. `/_next/static/chunks/` and `/_next/image` are NOT here: those are the app.
 *  - `.hot-update.` — the webpack HMR file suffix, for any webpack app (CRA, Rspack, plain webpack).
 *  - `/@vite/` (`client`, `env`), `/@react-refresh`, `/__vite_ping` — the Vite dev client, which is
 *    what SvelteKit, Astro, Remix and plain Vite all run. Verified present in vite@7/vite@8 and in
 *    astro@7's dist. Vite's `/@id/` and `/@fs/` are NOT here: those load the app's own modules.
 */
export const DevToolingChannel = {
  NEXT_DEV_OVERLAY: '/__nextjs',
  NEXT_HMR: '/_next/webpack-hmr',
  NEXT_HMR_CHUNKS: '/_next/static/webpack/',
  WEBPACK_HOT_UPDATE: '.hot-update.',
  VITE_CLIENT: '/@vite/',
  VITE_REACT_REFRESH: '/@react-refresh',
  VITE_PING: '/__vite_ping',
} as const;
export type DevToolingChannel = (typeof DevToolingChannel)[keyof typeof DevToolingChannel];

const DEV_TOOLING_PATTERNS: readonly string[] = Object.values(DevToolingChannel);

/**
 * Is this URL dev tooling rather than the app? Used to keep such calls out of the settle decision and
 * out of contradiction hunting. Never used to HIDE the call: the event stays in the timeline and the
 * exclusion is disclosed alongside the verdict.
 */
export function isDevToolingUrl(url: string | undefined): boolean {
  if (url === undefined) return false;
  return DEV_TOOLING_PATTERNS.some((pattern) => url.includes(pattern));
}

/**
 * Schemes whose "host" is not a host at all — the app's own machinery, never somebody else's server.
 *
 * `ipc://` is a desktop command (see IPC_URL_SCHEME), `data:`/`blob:` are bytes the page itself made.
 * None of them can be third-party, so the axis below declines to judge them.
 */
const FIRST_PARTY_PROTOCOLS: readonly string[] = ['http:', 'https:'];

/** How many trailing labels of a hostname stand in for the registrable domain. */
const REGISTRABLE_LABELS = 2;

function hostOf(url: string, base: string): string | undefined {
  try {
    const parsed = new URL(url, base);
    if (!FIRST_PARTY_PROTOCOLS.includes(parsed.protocol)) return undefined;
    return parsed.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * The registrable domain, approximated by the last two labels.
 *
 * ponytail: no public-suffix list. `foo.co.uk` and `bar.co.uk` read as the same site, which keeps a
 * third-party call classified as first-party — i.e. it preserves today's behaviour rather than
 * inventing a new one. The opposite approximation (hostname equality alone) would have broken the
 * far more common `app.example.com` calling `api.example.com`, which is the app's OWN backend, and
 * silenced the detector where it earns its keep. Swap in a PSL if a real app is ever mis-graded.
 */
function registrableDomain(host: string): string {
  const labels = host.split('.');
  if (labels.length <= REGISTRABLE_LABELS) return host;
  // An IPv4 literal has four labels and no registrable domain — compare it whole.
  if (/^[0-9.]+$/.test(host)) return host;
  return labels.slice(-REGISTRABLE_LABELS).join('.');
}

/**
 * Is this call to somebody ELSE's site — an analytics beacon, a vendor SDK bootstrap, a CDN ping?
 *
 * The axis a verdict needs and never had. A contradiction is a statement about the app under test,
 * and a failed third-party request says nothing about whether the caller's action worked: reported
 * from several apps, any analytics package installed was enough to grade a correct drive
 * `contradicted`, and on one app every assertion came back that way forever.
 *
 * Deliberately NOT a vendor list. `DevToolingChannel` above states why a list is the wrong shape
 * here: widening it until it can swallow an app endpoint turns a false negative into a false GREEN.
 * An origin comparison has no list to widen — it asks one structural question about the page itself.
 *
 * Ports are deliberately ignored: a dev app on :3000 talking to its API on :8787 is the ordinary
 * local setup, and grading that as a stranger's traffic would silence the detector on our own bench.
 *
 * Absence of `appUrl` disables the axis entirely — the same rule the document scoping follows, so a
 * caller who cannot say which page is under test gets exactly the behaviour it had before this.
 */
export function isThirdPartyUrl(url: string | undefined, appUrl: string | undefined): boolean {
  if (url === undefined || appUrl === undefined) return false;
  const target = hostOf(url, appUrl);
  const app = hostOf(appUrl, appUrl);
  if (target === undefined || app === undefined) return false;
  return registrableDomain(target) !== registrableDomain(app);
}

/**
 * The unredacted URL, kept so a grader can match `urlContains` against the path the app actually
 * requested. `url` is what is rendered to the agent and stored as the displayed value; this field
 * is the match haystack and must not be projected back into a transcript.
 *
 * Redaction runs at emit time and there is otherwise no raw copy. Public REST segments that happen
 * to follow a sensitive name (`/auth/token/refresh-context`, `/verify/CERT_INFY_10`) are rewritten
 * to `[REDACTED]`, so matching only `url` reports "the request did not happen".
 */
export const URL_RAW = 'urlRaw';

/**
 * The URL a filter or predicate should match against: the raw request when the observer kept one,
 * otherwise the displayed (possibly redacted) `url`.
 */
export function urlForMatch(data: Record<string, unknown>): string {
  const raw = data[URL_RAW];
  if ('string' === typeof raw && 0 < raw.length) return raw;
  const url = data['url'];
  return 'string' === typeof url ? url : '';
}
