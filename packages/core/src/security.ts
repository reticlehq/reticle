/**
 * Labels that can trigger an irreversible or money-moving effect.
 *
 * `send` used to be a bare token here, to cover moving money, and it taxed every ordinary button
 * that sends something: reported from the field on `Send check-in` (a POST that logs a text
 * message) and alongside it `Send message`, `Send invite`, `Send feedback`. A false block costs a
 * round-trip and, repeated, trains an agent to pass confirmDangerous reflexively — which is the one
 * outcome that makes this guard worthless.
 *
 * The money cases are still covered, through the thing being SENT rather than the act of sending:
 * `payment` catches "Send payment" and "Confirm payment" (which the bare-verb list missed entirely,
 * because `\bpay\b` does not match "payment"), and `send money`/`send funds` catch the rest.
 *
 * The guard stays deliberately asymmetric — a false block costs one round-trip, a missed block can
 * charge somebody's card — so this narrows the trigger without lowering money coverage. Both
 * directions are pinned in security.test.ts.
 */
const DANGEROUS_ACTION =
  /\b(delete|remove|destroy|erase|drop|terminate|revoke|reset|logout|log out|sign out|close account|cancel subscription|purchase|buy|pay|payment|place order|confirm order|deploy|publish|send money|send funds|transfer|withdraw|refund)\b/i;

/** The hostnames that ARE loopback outright, with no parsing: the name, and IPv6 ::1 both ways. */
const LOOPBACK_HOSTNAMES: readonly string[] = ['localhost', '::1', '0:0:0:0:0:0:0:1'];

/** IPv4 loopback is the whole 127.0.0.0/8 block, so the first octet is the entire test. */
const IPV4_LOOPBACK_FIRST_OCTET = '127';
const IPV4_OCTET_COUNT = 4;
const IPV4_OCTET_MAX = 255;

/** True only for literal loopback hosts, never lookalike DNS names such as 127.example.com. */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK_HOSTNAMES.includes(normalized)) return true;
  const octets = normalized.split('.');
  return (
    IPV4_OCTET_COUNT === octets.length &&
    IPV4_LOOPBACK_FIRST_OCTET === octets[0] &&
    octets.every((octet) => {
      if (!/^\d{1,3}$/.test(octet)) return false;
      const value = Number(octet);
      return value >= 0 && value <= IPV4_OCTET_MAX;
    })
  );
}

/**
 * Page protocols that mean "this document IS a local desktop app", not a website. A packaged
 * Electron renderer loads over `file:` (or a registered `app:` protocol); a Tauri webview loads over
 * `tauri:` on macOS/Linux. None of these can be reached by a remote attacker — there is no network
 * origin to serve them from — so a page on one is as local as `http://localhost`.
 */
const LOCAL_APP_PROTOCOLS: readonly string[] = ['file:', 'app:', 'tauri:'];

/**
 * The hostname Tauri v2 uses on Windows (and Android), where the webview needs a real http origin.
 * `.localhost` is reserved for loopback by RFC 6761, so this can never resolve to a remote host.
 */
const TAURI_HTTP_HOSTNAME = 'tauri.localhost';

/**
 * True when the page is local: an ordinary loopback document, or a desktop webview.
 *
 * This is what gates the SDK on the page side. The gate's purpose is to stop a REMOTE WEBSITE from
 * driving a developer's local bridge — a desktop app's own webview is not that, and treating it as
 * remote is what made Reticle refuse to start inside a packaged Electron or Tauri app.
 */
export function isLocalPage(protocol: string, hostname: string): boolean {
  if (isLoopbackHostname(hostname)) return true;
  if (LOCAL_APP_PROTOCOLS.includes(protocol.toLowerCase())) return true;
  return hostname.toLowerCase() === TAURI_HTTP_HOSTNAME;
}

/**
 * What `URL.origin` yields for a scheme that has no tuple origin — and what a browser puts in the
 * `Origin` header for the same. Desktop webviews are the common case: `tauri://localhost` on
 * macOS/Linux, `app://.` or `file://` in a packaged Electron renderer.
 */
export const OPAQUE_ORIGIN = 'null';

/**
 * True when an Origin carries no attributable host — a desktop webview or a `file://` document.
 * Such an origin cannot be checked against `isLoopbackHostname`; callers must fall back to the
 * pairing token, exactly as they do for a request that omits `Origin` entirely.
 */
export function isOpaqueOrigin(origin: string): boolean {
  try {
    return new URL(origin).origin === OPAQUE_ORIGIN;
  } catch {
    return true;
  }
}

/** Best-effort classifier for labels and tool names that can trigger irreversible effects. */
export function isDangerousActionText(text: string): boolean {
  return DANGEROUS_ACTION.test(text.replace(/[_-]+/g, ' '));
}
