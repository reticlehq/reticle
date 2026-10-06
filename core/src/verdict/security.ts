/**
 * Labels that can trigger an irreversible or money-moving effect.
 *
 * `send` is deliberately NOT a bare token here. It taxes every ordinary button that sends
 * something — `Send message`, `Send invite`, `Send feedback`, `Send check-in` — and a false block
 * costs a round-trip and, repeated, trains an agent to pass confirmDangerous reflexively, which is
 * the one outcome that makes this guard worthless.
 *
 * The money cases are still covered, through the thing being SENT rather than the act of sending:
 * `payment` catches "Send payment" and "Confirm payment" (which the bare-verb list missed entirely,
 * because `\bpay\b` does not match "payment"), and `send money`/`send funds` catch the rest.
 *
 * `logout` / `log out` / `sign out` are deliberately absent for the same reason: signing out is
 * reversible, and the words fire on almost every authenticated drive.
 *
 * The guard stays deliberately asymmetric — a false block costs one round-trip, a missed block can
 * charge somebody's card — so the trigger narrows without lowering money coverage. Both directions
 * are pinned in security.test.ts.
 */
/**
 * Labels that read as irreversible: something is destroyed, or money moves.
 *
 * `deploy` and `publish` are deliberately absent. The guard's contract — written at the top of
 * act-danger.ts — is "a money-moving or destructive control", and a deploy is neither: nothing is
 * destroyed, nothing is paid, and the thing it produces did not exist before. CONSEQUENTIAL is a
 * wider net than this list is allowed to be, or half the buttons in a dev tool sit behind a
 * permission flag — and a guard that fires on a control it was never written to catch trains agents
 * to route around it, which generalises to the buttons that DO matter.
 */
const DANGEROUS_ACTION =
  /\b(delete|remove|destroy|erase|drop|terminate|revoke|reset|close account|cancel subscription|purchase|buy|pay|payment|place order|confirm order|send money|send funds|transfer|withdraw|refund)\b/i;

/**
 * Roles that pick a VALUE, not perform an action. Selecting "Payment" as a document type is not a
 * payment, and choosing "Refund" from a reason group is not a refund -- the act those choices feed
 * is the submit that follows, and that control is judged on its own terms.
 *
 * `radio` joins `option` on exactly that argument. Reported from the field alongside the other
 * false positives in the same session: choosing "Inlet" from two radio-like choices was blocked,
 * and the reporter's summary is the cost -- "I ended up passing confirmDangerous: true reflexively
 * on every action, which is how a safety guard becomes decoration". A guard that fires on picking a
 * value is not protecting the destructive action either.
 *
 * `checkbox` is deliberately NOT here. It is a value picker too, but it is also the shape a
 * one-click irreversible confirmation takes ("Delete this repository" with no separate submit), and
 * this guard is asymmetric on purpose: a false block costs a round trip, a missed block cannot be
 * undone. `menuitem` stays out for the reason it always did -- a menu item labelled Delete IS one.
 */
const VALUE_PICKER_ROLES: ReadonlySet<string> = new Set(['option', 'radio']);

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

/**
 * What the control's own ELEMENT says about whether pressing it can have an effect.
 *
 * The destructive-label pattern decides on the words a control exposes. Two of those words are the
 * element's structure rather than its label: a handler, and the form it belongs to. A caller that
 * has the element reads them and hands them over here; a caller that has only a descriptor must
 * prove the same facts or nothing is exempted.
 *
 * `isAnchor` is a required fact, not a nicety. A `role="link"` is a free string any page can write,
 * so `<div role="link" onclick="…">Delete account</div>` would otherwise be exempted on the
 * strength of a claim the element does not support.
 */
export interface LinkAttributes {
  /** The resolved `href`, when the control has one. */
  href?: string;
  /** True only when the element IS an anchor (`<a>`), never for a role an author spelled. */
  isAnchor?: boolean;
  /**
   * Whether the element carries a handler: `true` when one is visible (an inline attribute, or a
   * framework adapter's reading of the fibre), `false` only when a caller actually looked and found
   * none, and `undefined` when no caller could look at all.
   *
   * The distinction is load-bearing. A handler bound with plain `addEventListener` leaves no trace
   * the DOM will answer, so an unread element and a handlerless one look identical from outside;
   * reading the first as the second is what lets a wired-up link take the exemption. Unknown
   * therefore refuses, exactly as an absent `isAnchor` does — proven narrows, unproven keeps the
   * block.
   */
  hasClickHandler?: boolean;
  /** True when the control submits a form, or sits inside one. */
  insideForm?: boolean;
  /**
   * True when the element carries a marker that says the app will turn the click into a non-GET
   * request: `data-method`, `data-turbo-method`, `data-remote`, or an `hx-*` verb attribute.
   *
   * These are the Rails/Turbo/htmx/UJS idiom for "this anchor is a button in disguise" — the click
   * still looks like a GET to an attribute check, but the framework intercepts it and issues a
   * DELETE/POST. Absent means no such marker was seen, which is what `undefined` and `false` both
   * look like; only `true` refuses, so a caller that does not read the attributes loses nothing it
   * would otherwise have had.
   */
  nonGetMarker?: boolean;
}

/**
 * The roles a control can carry and still be a plain navigation link.
 *
 * `getRole` answers `link` for an `<a href>` and `generic` for an anchor without one, and an author
 * may spell either explicitly. Anything else — a button, a menuitem, a checkbox — performs an act
 * rather than asking for a URL, so it is never handed the link exemption.
 */
const LINK_ROLES: ReadonlySet<string> = new Set(['link', 'generic']);

/**
 * Schemes a link may carry and still count as navigation.
 *
 * `javascript:` and `data:` are the two that make an href EXECUTABLE, and an executable URL is an
 * act however plain the anchor around it looks — the guard's own list of loopback and local-app
 * schemes already exists because a scheme decides what a string means. A bare `mailto:` or `tel:`
 * changes nothing by itself, but it is not navigation either, so it is not exempted: the allow-list
 * is http(s) and relative, and everything else keeps the block.
 */
const NAVIGATION_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * True when following this href fetches a document rather than running something.
 *
 * Resolved against `location`'s own base where there is one, so a relative path (no scheme at all)
 * and a protocol-relative `//host/path` are both readable. A `javascript:` href parses with that
 * protocol and is refused here, which is the case an allow-list on the scheme exists for.
 */
function isNavigationHref(href: string): boolean {
  if (0 === href.length || href.startsWith('#')) return false;
  try {
    return NAVIGATION_PROTOCOLS.has(new URL(href, 'http://navigation.invalid').protocol);
  } catch {
    return false;
  }
}

/**
 * An `<a href>` that moves by GET, with nothing wired to it and no form of its own.
 *
 * The destructive-label pattern reads a control's `href` along with its text, which is right for a
 * button whose label is an icon — its `formAction` is the only place it says what it does. On an
 * anchor the href is an ADDRESS, and addresses carry the pattern's words: `Orders & invoices`
 * pointing at `/billing/payment` is refused today for the `payment` in the URL, and a GET to that URL
 * changes nothing on its own.
 *
 * The scheme is checked, not the origin. `javascript:` and `data:` are refused by `isNavigationHref`,
 * so an executable URL never takes the exemption, but a cross-origin `https:` href does, because the
 * guard does not compare the href's origin against the page's.
 *
 * This predicate is currently unreachable in production, which is stated here rather than left for a
 * reader to discover. It needs a definite `hasClickHandler: false`, and no shipped producer supplies
 * one: React answers `true` or `undefined`, since props are the only thing a fibre exposes and it
 * can prove a handler exists but never that none does, and no other adapter registers a probe, so a
 * page with no adapter reads `undefined` as well. What this is, then, is the plumbing for the
 * exemption, held in the safe direction: it grants one only when a source can honestly prove a link
 * has no handler, and nothing can today. The tests that show it exempting hand the predicate a
 * definite `false` (the browser ones through a probe that reads the element directly), which models a
 * page where that reading is obtainable.
 *
 * The checks below stay, because each is what keeps the exemption narrow on the day a producer
 * exists: the href must use a scheme that fetches a document, the link must be a real anchor and not
 * a `role="link"` on a `div`, it must not sit inside a form, and it must not carry a framework's
 * marker for a rewritten non-GET request. `href="#"` is refused as well, because an inert fragment
 * href plus a handler is the idiom for "the act lives elsewhere", which makes it the href that tells
 * you least.
 */
export function isPlainNavigationLink(role: string | undefined, attrs: LinkAttributes): boolean {
  if (role === undefined || !LINK_ROLES.has(role.trim().toLowerCase())) return false;
  if (true !== attrs.isAnchor) return false;
  // Only a definite handlerless reading is exempted. `undefined` means no caller could inspect the
  // element, and an unread element is indistinguishable from one wired up with `addEventListener`,
  // so unknown keeps the block rather than being optimistically read as "no handler".
  if (false !== attrs.hasClickHandler) return false;
  if (true === attrs.insideForm) return false;
  // A marker that the framework rewrites the click into DELETE/POST. The href looks like a GET and
  // there is no attribute-level handler, so without this the anchor reads as plain navigation while
  // the click destroys something.
  if (true === attrs.nonGetMarker) return false;
  const href = attrs.href?.trim();
  return href !== undefined && isNavigationHref(href);
}

/**
 * Best-effort classifier for labels and tool names that can trigger irreversible effects.
 *
 * `role` is the resolved ARIA role of the control. An `option` is a value picker: its text names
 * the value, not an action, so "Payment" as a select choice is not a payment. Callers that have no
 * role (a tool name, a click with no role on the descriptor) omit it and the text decides.
 */
export function isDangerousActionText(text: string, role?: string): boolean {
  if (role !== undefined && VALUE_PICKER_ROLES.has(role.trim().toLowerCase())) return false;
  return DANGEROUS_ACTION.test(text.replace(/[_-]+/g, ' '));
}

/**
 * The same classification, told what the control cannot say for itself.
 *
 * A plain `<a href>` moves by GET and changes nothing, so its label and its address are not
 * evidence of a destructive act — the reporter's `Orders & invoices` link was refused for the
 * `payment` in its href, and the way past the refusal is `confirmDangerous: true`, which is how a
 * guard becomes decoration. Narrowing is what keeps the guard worth heeding.
 *
 * The role alone cannot decide this: a `role="link"` on a `<div>` is a free string any page can
 * write, so the caller's own facts about the element — does it carry a handler, does it sit in a
 * form — are the ones consulted here.
 */
export function classifyActionText(
  text: string,
  role: string | undefined,
  attrs: LinkAttributes,
): boolean {
  if (isPlainNavigationLink(role, attrs)) return false;
  return isDangerousActionText(text, role);
}
