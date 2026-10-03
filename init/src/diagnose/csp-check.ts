/**
 * Does this app's Content-Security-Policy let the browser reach the Reticle bridge?
 *
 * Two independent field reports, both Next: `init` reported every step successful, the SDK mounted,
 * the dial URL was correct, and the app never connected because a strict `connect-src` excluded
 * `ws://localhost:<port>`. The browser blocks the WebSocket and says so in its own console, which
 * nothing on the Reticle side reads — so `status` and `doctor` reported perfect health at an app
 * that could not connect at all. A setup step that exits 0 while leaving the user broken is the
 * failure mode this file exists to prevent.
 *
 * A TEXT SCAN, deliberately. `headers()` is a function; `init` cannot execute a user's Next config
 * without importing their whole app, and the thing worth finding is the policy string a developer
 * typed — in `next.config.*`, in middleware, or in a `<meta http-equiv>` tag. The scan finds the
 * string wherever it is written.
 *
 * NARROW on purpose: it fires only when a `connect-src` exists AND does not admit the bridge. No
 * CSP, or one that already covers us, produces nothing. A warning that fires on a working setup
 * costs precisely what a green check on a broken one costs, and this file exists because of the
 * second kind.
 */

/** Sources that admit any ws origin, so the bridge is already reachable. */
const WILDCARDS: readonly string[] = ['*', 'ws:', 'wss:', 'ws://*', 'https:'];

/** The two hosts the SDK may dial. `localhost` and the IPv4 loopback are different CSP sources. */
function bridgeOrigins(port: number): string[] {
  return [`ws://localhost:${String(port)}`, `ws://127.0.0.1:${String(port)}`];
}

/**
 * The `connect-src` directive's source list, or undefined when the text declares none.
 *
 * Matches every occurrence to the end of the directive (`;`) or the end of the enclosing quoted
 * string, which is how these are written in both a Next `headers()` value and a `<meta content="...">`.
 */
interface DirectiveSourceList {
  readonly sources: readonly string[];
  /** True only when source text shows this occurrence is the other branch of one ternary. */
  readonly alternativeWithPrevious: boolean;
}

const TERNARY_GAP = /^"\s*:\s*"$/;
const EXPRESSION_EDGE = /^["'`})\]]+|["'`})\]]+$/g;

function directiveSources(text: string, directive: string): DirectiveSourceList[] | undefined {
  // Stops at the directive separator or the closing double quote of the enclosing string. Single
  // quotes are NOT terminators: `'self'` is a source, not the end of the list.
  const matches = [...text.matchAll(new RegExp(`${directive}([^;"]*)`, 'gi'))];
  if (0 === matches.length) return undefined;
  return matches.map((match, index) => {
    const previous = matches[index - 1];
    const previousEnd =
      previous === undefined ? undefined : (previous.index ?? 0) + previous[0].length;
    return {
      sources: (match[1] ?? '')
        .split(/\s+/)
        .map((source) => source.trim())
        .filter((source) => source.length > 0),
      alternativeWithPrevious:
        previousEnd !== undefined &&
        TERNARY_GAP.test(text.slice(previousEnd, match.index ?? previousEnd)),
    };
  });
}

/**
 * What this policy allows a WebSocket to reach — `connect-src`, or `default-src` when it is absent.
 *
 * The fallback is the CSP spec's, and leaving it out made the check blind to the commonest strict
 * policy there is. MarkText, a production Electron editor, declares
 * `default-src 'self'; script-src 'self'; …` with NO `connect-src`: its WebSockets are restricted to
 * 'self', the bridge is blocked, and this returned "no problem" because it was looking for a
 * directive that was not written. Every fetch-directive falls back to `default-src`; that is what
 * `default` means, and it is why an author does not repeat themselves.
 *
 * Still undefined when NEITHER is present — a policy that constrains neither is not blocking us.
 */
function connectSrcSources(text: string): DirectiveSourceList[] | undefined {
  const sources = directiveSources(text, 'connect-src') ?? directiveSources(text, 'default-src');
  return sources?.map(({ sources: sourceList, alternativeWithPrevious }) => ({
    sources: sourceList.map((source) => source.replace(EXPRESSION_EDGE, '')),
    alternativeWithPrevious,
  }));
}

/**
 * The problem with this app's `connect-src`, or undefined if there is not one.
 *
 * `https:` counts as a wildcard here only in the sense that a policy written that loosely will not
 * be the thing blocking a dev WebSocket; the check stays quiet rather than arguing about it.
 */
export function cspConnectSrcProblem(text: string, port: number): string | undefined {
  const sources = connectSrcSources(text);
  if (sources === undefined || 0 === sources.length) return undefined;
  const wanted = bridgeOrigins(port);
  // Separate CSP policies are all enforced, so every group must admit the bridge. Two occurrences
  // that are alternate branches of one source-level ternary are not enforced together: either
  // branch admitting the bridge is enough for that group.
  const policiesThatAdmitBridge: boolean[] = [];
  for (const { sources: sourceList, alternativeWithPrevious } of sources) {
    const admitsBridge =
      sourceList.some((source) => WILDCARDS.includes(source)) ||
      wanted.every((origin) => sourceList.includes(origin));
    if (alternativeWithPrevious) {
      policiesThatAdmitBridge[policiesThatAdmitBridge.length - 1] ||= admitsBridge;
    } else {
      policiesThatAdmitBridge.push(admitsBridge);
    }
  }
  // BOTH, not either: the SDK picks its host from how the page was served, and a policy that admits
  // one is a coin flip. A coin flip that fails is indistinguishable from every other silent
  // non-connect, which is the whole cost being avoided here.
  if (policiesThatAdmitBridge.every(Boolean)) return undefined;
  const missing = wanted;
  return (
    `this app declares a Content-Security-Policy whose \`connect-src\` does not admit the Reticle ` +
    `bridge: ${missing.join(' and ')} ${1 === missing.length ? 'is' : 'are'} missing. The browser ` +
    `will block the WebSocket and report it in ITS console only — every check on the Reticle side ` +
    `will pass while the app never connects. ${devCspAddition(port)}`
  );
}

/**
 * What this policy allows a SCRIPT to be — `script-src`, or `default-src` when it is absent.
 *
 * Same fallback and same reason as {@link connectSrcSources}: every fetch-directive falls back to
 * `default-src`, which is why an author writing `default-src 'self'` does not repeat themselves.
 */
function scriptSrcSources(text: string): DirectiveSourceList[] | undefined {
  return directiveSources(text, 'script-src') ?? directiveSources(text, 'default-src');
}

/**
 * Would this policy stop the pasted connect snippet from RUNNING?
 *
 * The `connect-src` check above assumes the SDK got as far as opening a socket. Under a policy
 * without `'unsafe-inline'` it never does: the snippet `init` prints is an inline
 * `<script type="module">`, the browser refuses to execute it, and there is no SDK, no socket and
 * nothing for `connect-src` to block. `reticle open` then reports "no session / app carries no SDK",
 * which sends diagnosis at the wrong cause entirely (#679).
 *
 * The rule is the spec's, not a guess:
 *
 * - `'unsafe-inline'` is the ONLY source that admits an inline script. `*` does not — a host
 *   wildcard says nothing about inline code, and reading it as permission is the commonest CSP
 *   misconception there is.
 * - a nonce, a hash, or `'strict-dynamic'` makes browsers IGNORE `'unsafe-inline'` entirely. A
 *   policy carrying both is a policy that blocks inline scripts, and one carrying a nonce blocks
 *   ours specifically: the nonce is minted for the app's own tags, not for a snippet pasted in by
 *   hand.
 */
function blocksInlineScript(sources: readonly string[]): boolean {
  const overridesUnsafeInline = sources.some(
    (source) =>
      source.startsWith("'nonce-") || source.startsWith("'sha") || "'strict-dynamic'" === source,
  );
  if (overridesUnsafeInline) return true;
  return !sources.includes("'unsafe-inline'");
}

/**
 * The problem with this app's `script-src`, or undefined if there is not one.
 *
 * Reports the remedy that works under `'self'` — serve the connect code as an external module file —
 * rather than telling anyone to weaken their policy with `'unsafe-inline'`.
 */
export function cspInlineScriptProblem(text: string, port: number): string | undefined {
  const sources = scriptSrcSources(text);
  if (sources === undefined || 0 === sources.length) return undefined;
  // The same CSP composition rule applies here: any independent blocking policy wins, while a
  // source-level conditional is safe when either of its mutually exclusive branches permits inline.
  const policiesThatBlockInlineScript: boolean[] = [];
  for (const { sources: sourceList, alternativeWithPrevious } of sources) {
    const blocksInline = blocksInlineScript(sourceList);
    if (alternativeWithPrevious) {
      policiesThatBlockInlineScript[policiesThatBlockInlineScript.length - 1] &&= blocksInline;
    } else {
      policiesThatBlockInlineScript.push(blocksInline);
    }
  }
  if (!policiesThatBlockInlineScript.some(Boolean)) return undefined;
  return (
    `this app declares a Content-Security-Policy whose \`script-src\` does not admit an inline ` +
    `script, so the connect snippet never executes. Nothing on the Reticle side can see this: with ` +
    `no SDK there is no socket, and \`reticle open\` reports "no session / app carries no SDK" — ` +
    `the wrong cause. ${externalScriptRemedy()} ${devCspAddition(port)}`
  );
}

/** Where the external connect module goes, for an app served from a static directory. */
export const EXTERNAL_CONNECT_PATH = 'public/reticle-connect.js';

/** The remedy that works under `script-src 'self'`, as text to copy. */
export function externalScriptRemedy(): string {
  return (
    `Serve the connect code as an EXTERNAL module instead: put it in ` +
    `\`${EXTERNAL_CONNECT_PATH}\` and reference it with ` +
    `\`<script type="module" src="/reticle-connect.js"></script>\`, which \`script-src 'self'\` ` +
    `already allows. Note that an external module is DEFERRED, so the app's own classic scripts run ` +
    `first and requests they fire before the SDK attaches are not observed.`
  );
}

/** The exact addition to paste. Text to copy, not advice to interpret. */
export function devCspAddition(port: number): string {
  return (
    `Add to \`connect-src\` in development only (e.g. behind ` +
    `\`process.env.NODE_ENV === 'development'\`): ` +
    `${bridgeOrigins(port).join(' ')}`
  );
}

/** A `<meta http-equiv="Content-Security-Policy" content=…>` tag's content attribute, by quote. */
const CSP_META = /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi;
const CONTENT_ATTR = /(\bcontent\s*=\s*)(["'])((?:(?!\2).)*)\2/i;

/** A loopback WebSocket source, with its port captured. */
const LOOPBACK_WS = /^ws:\/\/(?:localhost|127\.0\.0\.1):(\d+)$/;

/**
 * The ports for which BOTH bridge origins are present — the pair this file writes, and the only
 * loopback sources it may take back out.
 *
 * A port move used to APPEND the new pair beside the old one, so the policy kept admitting a port
 * nothing listened on and grew a pair per move. One `ws://localhost:3000` the app wrote for its own
 * dev server is not a pair, and is left alone.
 */
function stalePairs(sources: readonly string[], port: number): Set<string> {
  const ports = sources.flatMap((source) => LOOPBACK_WS.exec(source)?.[1] ?? []);
  return new Set(
    ports.filter(
      (p) =>
        String(port) !== p && bridgeOrigins(Number(p)).every((origin) => sources.includes(origin)),
    ),
  );
}

/** The policy with both bridge origins admitted to `connect-src`, every other directive untouched. */
function withBridgeOrigins(policy: string, port: number): string {
  const origins = bridgeOrigins(port);
  const directives = policy.split(';');
  const connect = directives.findIndex((d) => /^\s*connect-src\b/i.test(d));
  if (-1 !== connect) {
    const current = directives[connect] ?? '';
    const sources = current.trim().split(/\s+/);
    const stale = stalePairs(sources, port);
    const kept = sources.filter((source) => !stale.has(LOOPBACK_WS.exec(source)?.[1] ?? ''));
    const missing = origins.filter((origin) => !kept.includes(origin));
    const lead = /^\s*/.exec(current)?.[0] ?? '';
    directives[connect] = `${lead}${[...kept, ...missing].join(' ')}`;
    return directives.join(';');
  }
  // No connect-src: the socket falls back to default-src, so the new directive starts from what
  // default-src already allowed — adding it bare would take 'self' away from every fetch the app does.
  const fallback: readonly string[] = directiveSources(policy, 'default-src')?.[0]?.sources ?? [];
  const added = ` connect-src ${[...fallback, ...origins].join(' ')}`;
  const trimmed = policy.trimEnd();
  return trimmed.endsWith(';') ? `${trimmed}${added};` : `${trimmed};${added}`;
}

/**
 * The same HTML with every CSP `<meta>` that blocks the bridge made to admit it, or undefined when
 * none needed it — the one policy location `init` can edit safely, because it is a file of the app's
 * own and the edit is a pair of sources appended to one directive.
 *
 * Reproduced on electron-vite's own template: `default-src 'self'` and no `connect-src`, so the
 * bridge WebSocket is refused and init waited out its whole budget. The origins are loopback-only;
 * a static `<meta>` has no development branch, so they are present in a packaged build too, where
 * nothing listens on them. On a port move the pair is REPLACED (see stalePairs).
 */
export function patchCspMetaConnectSrc(html: string, port: number): string | undefined {
  let changed = false;
  const out = html.replace(CSP_META, (tag) =>
    tag.replace(CONTENT_ATTR, (whole, head: string, quote: string, policy: string) => {
      if (cspConnectSrcProblem(policy, port) === undefined) return whole;
      changed = true;
      return `${head}${quote}${withBridgeOrigins(policy, port)}${quote}`;
    }),
  );
  return changed ? out : undefined;
}

/** What the patched step says it did. */
export function cspPatchedDetail(port: number): string {
  return (
    `admit the Reticle bridge (${bridgeOrigins(port).join(' ')}) to connect-src — the policy ` +
    'blocked the WebSocket, so the app could never connect'
  );
}

/** The step title, named here so `doctor` and the plan cannot drift apart on what this check is called. */
export const CSP_STEP_TITLE = 'Content-Security-Policy';
