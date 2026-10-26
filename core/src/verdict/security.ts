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
const DESTROY_WORDS =
  'delete|remove|destroy|erase|drop|terminate|revoke|reset|close account|cancel subscription';
const MONEY_WORDS =
  'purchase|buy|pay|payment|place order|confirm order|send money|send funds|transfer|withdraw|refund';
const DANGEROUS_ACTION = new RegExp(`\\b(${DESTROY_WORDS}|${MONEY_WORDS})\\b`, 'i');
/** Only the words that destroy something. A link target is judged by these, not by money words. */
const DESTROY_ACTION = new RegExp(`\\b(${DESTROY_WORDS})\\b`, 'i');

/** Underscores and hyphens join words in names and paths: `delete_account`, `close-account`. */
const WORD_JOINERS = /[_-]+/g;

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

/** The suffix of a name RFC 6761 reserves for loopback (`app.localhost`, `feat.app.localhost`). */
const LOCALHOST_SUFFIX = '.localhost';

/** IPv4 loopback is the whole 127.0.0.0/8 block, so the first octet is the entire test. */
const IPV4_LOOPBACK_FIRST_OCTET = '127';
const IPV4_OCTET_COUNT = 4;
const IPV4_OCTET_MAX = 255;

/**
 * True only for literal loopback hosts and `localhost`, never a lookalike DNS name such as
 * 127.example.com. Names under `.localhost` are not included: this is the guard against DNS
 * rebinding, and a browser that sends those names to DNS lets a hostile network answer them.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK_HOSTNAMES.includes(normalized)) {
    return true;
  }
  const octets = normalized.split('.');
  return (
    IPV4_OCTET_COUNT === octets.length &&
    IPV4_LOOPBACK_FIRST_OCTET === octets[0] &&
    octets.every((octet) => {
      if (!/^\d{1,3}$/.test(octet)) {
        return false;
      }
      const value = Number(octet);
      return value >= 0 && value <= IPV4_OCTET_MAX;
    })
  );
}

/**
 * True for a name under `.localhost`, such as the `<branch>.<app>.localhost` a dev proxy serves for
 * each git worktree. RFC 6761 reserves these names for loopback, and browsers resolve them locally.
 */
export function isLocalhostSubdomain(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized.endsWith(LOCALHOST_SUFFIX) &&
    normalized.length > LOCALHOST_SUFFIX.length &&
    !normalized.startsWith('.')
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
 * True when the page is local: an ordinary loopback document, or a desktop webview.
 *
 * This is what gates the SDK on the page side. The gate's purpose is to stop a REMOTE WEBSITE from
 * driving a developer's local bridge — a desktop app's own webview is not that, and treating it as
 * remote is what made Reticle refuse to start inside a packaged Electron or Tauri app.
 */
export function isLocalPage(protocol: string, hostname: string): boolean {
  // `isLocalhostSubdomain` also covers `tauri.localhost`, the http origin Tauri v2 uses on Windows.
  if (isLoopbackHostname(hostname) || isLocalhostSubdomain(hostname)) {
    return true;
  }
  return LOCAL_APP_PROTOCOLS.includes(protocol.toLowerCase());
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

/** The extensions a filename token can end in, as a set for the scan below. */
const FILENAME_EXTENSIONS: ReadonlySet<string> = new Set([
  'webm',
  'mp4',
  'mov',
  'mkv',
  'avi',
  'mp3',
  'wav',
  'ogg',
  'flac',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'avif',
  'bmp',
  'pdf',
  'zip',
  'tar',
  'gz',
  'txt',
  'csv',
  'json',
  'xml',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
]);

/** One maximal run of filename characters in a label: a token, or a token with a tail. */
const FILENAME_RUN = /[\w.-]+/g;

/** One character of a file extension. Extensions are letters and digits: `mp4`, `mp3`. */
const EXTENSION_CHARACTER = /[a-zA-Z0-9]/;

/**
 * The end of the filename token at the start of `run`, or 0 when the run starts with no
 * filename token. Try the last dot first, the way a greedy match does: the longest name
 * part that still ends in a known extension wins. The extension must end at a word
 * boundary: the end of the run, a dot, or a hyphen. So `report.pdf.backup` starts with
 * the token `report.pdf`, and its tail stays in the text.
 */
function filenameTokenEnd(run: string): number {
  for (let dot = run.lastIndexOf('.'); 1 <= dot; dot = run.lastIndexOf('.', dot - 1)) {
    let end = dot + 1;
    let extension = '';
    while (end < run.length && EXTENSION_CHARACTER.test(run.charAt(end))) {
      extension += run.charAt(end).toLowerCase();
      end += 1;
    }
    if (!FILENAME_EXTENSIONS.has(extension)) {
      continue;
    }
    const after = run.charAt(end);
    if ('' === after || '.' === after || '-' === after) {
      return end;
    }
  }
  return 0;
}

/**
 * Strip filename-like tokens from text before the text is classified.
 * Callers apply this to a control's name, text and value only: an href or a form action is a
 * target, not words on the control, and its destination must be read whole.
 *
 * The scan walks each maximal run of filename characters once and checks that run's dots
 * once, so a label costs time in proportion to its length. The one-pattern version this
 * replaces took about 97 seconds on a 100,000 hyphen label in a local check; the scan
 * takes milliseconds on the same label, and a fuzz comparison over 20,000 generated
 * labels found no difference in what it strips.
 */
export function withoutFilenameTokens(text: string): string {
  return text.replace(FILENAME_RUN, (run) => {
    const end = filenameTokenEnd(run);
    return 0 === end ? run : ` ${run.slice(end)}`;
  });
}

/**
 * Best-effort classifier for labels and tool names that can trigger irreversible effects.
 *
 * `role` is the resolved ARIA role of the control. An `option` is a value picker: its text names
 * the value, not an action, so "Payment" as a select choice is not a payment. Callers that have no
 * role (a tool name, a click with no role on the descriptor) omit it and the text decides.
 */
export function isDangerousActionText(text: string, role?: string): boolean {
  if (role !== undefined && VALUE_PICKER_ROLES.has(role.trim().toLowerCase())) {
    return false;
  }
  return DANGEROUS_ACTION.test(text.replace(WORD_JOINERS, ' '));
}

/**
 * Is following a link to this href destructive? A link that navigates is a GET: opening a page moves
 * no money, so a money word in a same-app path (`/billing/payment`) is not a reason to refuse it.
 * Typing card details has its own guard. The href is dangerous when its path destroys something
 * (`/account/delete`), or when it goes to a payment provider.
 */
/** An href that goes nowhere (`#…`, `javascript:`): the link is a button, judged by its words. */
const INERT_HREF = /^\s*(#.*|javascript:.*)?$/i;
export function isInertHref(href: string): boolean {
  return INERT_HREF.test(href);
}

export function isDangerousNavigation(href: string): boolean {
  return isPaymentProviderUrl(href) || DESTROY_ACTION.test(href.replace(WORD_JOINERS, ' '));
}

// ── What the Harness may press ────────────────────────────────────────────────────────────────
/*
 * An action that reaches outside the page or changes someone's workspace: it invites, sends,
 * shares, deletes, pays, publishes, revokes, transfers, signs out, changes a role or creates a key.
 * The Harness pressed Invite in a customer's workspace although its journey said "she does not send
 * an invite", and a planner-invented journey typed a new address and pressed Invite. A Harness drive
 * presses one only when its journey asks for that action; a saved flow's steps were asked for by
 * whoever recorded them. The agent's own guard (`isDangerousActionText`) is narrower on purpose.
 */
export const OutwardAction = {
  INVITE: 'invite',
  SEND: 'send',
  SHARE: 'share',
  DELETE: 'delete',
  PAY: 'pay',
  PUBLISH: 'publish',
  REVOKE: 'revoke',
  TRANSFER: 'transfer',
  SIGN_OUT: 'sign out',
  CHANGE_ROLE: 'change role',
  CREATE_KEY: 'create key',
  /** Reassigning, reopening, archiving, approving: changing an item's state for everyone. */
  CHANGE_STATE: 'change state',
} as const;
export type OutwardAction = (typeof OutwardAction)[keyof typeof OutwardAction];

/** Each outward action as words on a control (or in the request it points at), and in a journey. */
const OUTWARD_WORDS: readonly (readonly [OutwardAction, RegExp])[] = [
  [OutwardAction.INVITE, /\binvit(?:e|es|ed|ing|ation|ations)\b|\/invit/i],
  [OutwardAction.TRANSFER, /\b(?:transfer|send money|send funds|withdraw)\b/i],
  [OutwardAction.SEND, /\b(?:send|sends|sending|resend|email (?:it|them|the))\b/i],
  [OutwardAction.SHARE, /\b(?:share|shares|sharing)\b/i],
  [
    OutwardAction.DELETE,
    /\b(?:delete|deletes|deleting|remove|removes|removing|destroy|erase|drop)\b/i,
  ],
  [
    OutwardAction.PAY,
    /\b(?:pay|pays|paying|payment|purchase|buy|checkout|check out|subscribe|upgrade|place order|confirm order|refund|add (?:a )?card|start (?:the |your |a )?(?:\d+-day |free )?trial)\b|\/(?:billing|checkout)\b/i,
  ],
  [OutwardAction.PUBLISH, /\b(?:publish|publishes|deploy|deploys|go live)\b/i],
  [OutwardAction.REVOKE, /\b(?:revoke|revokes|deactivate|suspend)\b/i],
  [OutwardAction.SIGN_OUT, /\b(?:sign ?out|log ?out|sign off)\b/i],
  [
    OutwardAction.CHANGE_ROLE,
    /\b(?:change (?:the |their |his |her )?role|make (?:an? )?(?:admin|owner)|promote|demote|set role)\b/i,
  ],
  [OutwardAction.CREATE_KEY, /\b(?:create|generate|new|mint)(?: an?)?(?: api)? key\b|\/keys\b/i],
  [
    OutwardAction.CHANGE_STATE,
    /\b(?:reassign|reassigns|reopen|reopens|re-open|archive|archives|unarchive|approve|approves|reject|rejects|mark as (?:fixed|resolved|done|closed))\b/i,
  ],
];

/*
 * The payment boundary. "Start free trial" was refused as "would need to pay" on 3 of 4 explores:
 * the words on a button (trial, upgrade, subscribe, checkout) say nothing about whether money moves
 * on an app under test. Money moves when somebody types card or bank details, or leaves for a payment
 * provider, so those are the two things a Harness drive that was not asked to pay refuses.
 */

/** The origins of the payment providers an app sends a buyer to. A host or any subdomain of it. */
export const PAYMENT_PROVIDER_HOSTS = [
  'stripe.com',
  'checkout.dodopayments.com',
  'paddle.com',
  'lemonsqueezy.com',
  'paypal.com',
  'razorpay.com',
  'braintreegateway.com',
] as const;

/** Is this an absolute URL on a payment provider's origin? A relative URL stays on the app. */
export function isPaymentProviderUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return PAYMENT_PROVIDER_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** What a text field says about itself. Any part may be absent. */
export interface PaymentFieldFacts {
  autocomplete?: string | undefined;
  name?: string | undefined;
  id?: string | undefined;
  inputMode?: string | undefined;
  /** Its accessible name or placeholder. */
  label?: string | undefined;
}

/** The autocomplete tokens of a card: number, security code, expiry. */
const CARD_AUTOCOMPLETE = /\bcc-(?:number|csc|exp(?:-month|-year)?)\b/i;
/** A card or bank field by its name, id or label. */
const PAYMENT_FIELD_WORDS =
  /card ?(?:number|no\b)|\bcc ?num|\b(?:cvc|cvv|csc|cvc2|cvv2)\b|security code|card ?code|\bexpir(?:y|ation|es)\b|\bexp ?date\b|\bmm ?\/ ?yy\b|\biban\b|account ?number|routing ?number|sort ?code/i;

/**
 * Is this a field for card or bank details? `inputMode` alone decides nothing (a quantity is numeric
 * too); it travels in the facts so a numeric field named "cvv" still reads as one.
 */
export function isPaymentField(facts: PaymentFieldFacts): boolean {
  if (CARD_AUTOCOMPLETE.test(facts.autocomplete ?? '')) {
    return true;
  }
  const words = [facts.name, facts.id, facts.label]
    .map((w) => (w ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' '))
    .join(' ');
  return PAYMENT_FIELD_WORDS.test(words);
}

/**
 * The outward action a control would take, from its text and role; value pickers take none.
 *
 * Paying is never read from a control's words, only from where it goes: a link or form in `text`
 * that points at a payment provider. `PAY` stays in the journey vocabulary, so "she pays" allows it.
 */
export function outwardActionOf(text: string, role?: string): OutwardAction | undefined {
  if (role !== undefined && VALUE_PICKER_ROLES.has(role.trim().toLowerCase())) {
    return undefined;
  }
  if (text.split(/\s+/).some(isPaymentProviderUrl)) {
    return OutwardAction.PAY;
  }
  const words = text.replace(/[_-]+/g, ' ');
  return OUTWARD_WORDS.find(
    ([action, pattern]) => action !== OutwardAction.PAY && pattern.test(words),
  )?.[0];
}

/** A word that turns the action after it into one the journey forbids: "does not send". */
const NEGATION = /\b(?:not|no|never|without|nor|avoid|avoids|don't|doesn't|won't|didn't)\b/i;
/** How many words before an action a negation still governs it. */
const NEGATION_REACH = 4;

/**
 * The outward actions a journey asks for in so many words. "Invite a teammate" asks for invite;
 * "she does not send an invite" and "without sending" ask for nothing. Pure.
 */
export function outwardActionsAsked(journey: string): OutwardAction[] {
  const asked: OutwardAction[] = [];
  for (const [action, pattern] of OUTWARD_WORDS) {
    const global = new RegExp(pattern.source, 'gi');
    for (const match of journey.matchAll(global)) {
      const before = journey.slice(0, match.index).split(/\s+/).slice(-NEGATION_REACH).join(' ');
      if (!NEGATION.test(before)) {
        asked.push(action);
        break;
      }
    }
  }
  return asked;
}

/** What the Harness says, and the journey records, when it would not press one. */
export const outwardRefusal = (action: OutwardAction): string =>
  `would need to ${action} — not done (outward action): the journey does not ask for it`;
