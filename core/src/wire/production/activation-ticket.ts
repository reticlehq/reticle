import { HelloScope } from './hello-mode.js';
import { isLoopbackHostname } from '../../verdict/security.js';

/**
 * The activation ticket a page checks for itself before it loads the SDK on a live site.
 *
 * The service mints it and signs it with Ed25519. The page carries only the public key, so it can
 * check the ticket with no round trip and no secret. Format: `<payload>.<signature>`. Both parts
 * are base64url. `payload` is the JSON of `ActivationTicketPayload`, and the signature covers the
 * ASCII bytes of the payload part as it is written.
 *
 * Hand-narrowed and not a zod schema on purpose: the page-side loader imports this file, and zod
 * would put a schema library into every page load of a live site to check six fields.
 */

/** The query parameter the site opens with. The page loader removes it from the address bar. */
export const PRODUCTION_ACTIVATE_PARAM = 'reticle_activate';

/** The only ticket format this file reads. A new format gets a new number. */
export const ACTIVATION_TICKET_VERSION = 1;

/** Joins the payload part and the signature part. */
const TICKET_SEPARATOR = '.';
const ED25519 = 'Ed25519';
const RAW_KEY_FORMAT = 'raw';
const WS_PROTOCOL = 'ws:';
const WSS_PROTOCOL = 'wss:';

/** Bounds, so a page never parses an unbounded string from its own address bar. */
const MAX_TICKET_LENGTH = 4096;
const MAX_FIELD_LENGTH = 2048;

export interface ActivationTicketPayload {
  v: typeof ACTIVATION_TICKET_VERSION;
  /** The single-use HELLO token the bridge minted for this drive. The page sends it as `token`. */
  nonce: string;
  /** The page origin the ticket is for. Another origin refuses it. */
  origin: string;
  /** The bridge the page connects to. `wss://`, or `ws://` on a loopback host only. */
  bridge: string;
  scope: HelloScope;
  /** When the ticket stops being valid, in epoch ms. */
  exp: number;
}

/** Why a page refused a ticket. The page does nothing in each case. */
export const ActivationRefusal = {
  MALFORMED: 'malformed ticket',
  BAD_SIGNATURE: 'the signature does not verify',
  EXPIRED: 'the ticket expired',
  WRONG_ORIGIN: 'the ticket is for another origin',
  INSECURE_BRIDGE: 'the bridge is not wss:// or a loopback ws://',
} as const;
export type ActivationRefusal = (typeof ActivationRefusal)[keyof typeof ActivationRefusal];

export type ActivationVerdict =
  { ok: true; payload: ActivationTicketPayload } | { ok: false; reason: ActivationRefusal };

type Subtle = typeof globalThis.crypto.subtle;
type SigningKey = Parameters<Subtle['sign']>[1];

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Undefined when the text is not base64url. */
function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

const isText = (value: unknown): value is string =>
  'string' === typeof value && 0 < value.length && value.length <= MAX_FIELD_LENGTH;

function readPayload(part: string): ActivationTicketPayload | undefined {
  const bytes = fromBase64Url(part);
  if (bytes === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || null === value) return undefined;
  const p = value as Record<string, unknown>;
  const scope = Object.values(HelloScope).find((s) => s === p.scope);
  if (
    p.v !== ACTIVATION_TICKET_VERSION ||
    !isText(p.nonce) ||
    !isText(p.origin) ||
    !isText(p.bridge) ||
    scope === undefined ||
    typeof p.exp !== 'number' ||
    !Number.isFinite(p.exp)
  ) {
    return undefined;
  }
  return {
    v: ACTIVATION_TICKET_VERSION,
    nonce: p.nonce,
    origin: p.origin,
    bridge: p.bridge,
    scope,
    exp: p.exp,
  };
}

function secureBridge(bridge: string): boolean {
  try {
    const url = new URL(bridge);
    if (url.protocol === WSS_PROTOCOL) return true;
    return url.protocol === WS_PROTOCOL && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

async function signatureVerifies(
  subtle: Subtle,
  publicKey: string,
  signature: Uint8Array<ArrayBuffer>,
  signed: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  const raw = fromBase64Url(publicKey);
  if (raw === undefined) return false;
  try {
    const key = await subtle.importKey(RAW_KEY_FORMAT, raw, { name: ED25519 }, false, ['verify']);
    return await subtle.verify({ name: ED25519 }, key, signature, signed);
  } catch {
    // A malformed key, or a browser with no Ed25519. Both mean: do not activate.
    return false;
  }
}

/**
 * Check a ticket against the service's public key (base64url, raw 32 bytes), the page origin and
 * the clock. Never throws.
 */
export async function verifyActivationTicket(
  ticket: string,
  options: { publicKey: string; origin: string; now: number; subtle?: Subtle },
): Promise<ActivationVerdict> {
  const parts = ticket.length <= MAX_TICKET_LENGTH ? ticket.split(TICKET_SEPARATOR) : [];
  const [payloadPart, signaturePart] = parts;
  const payload =
    2 === parts.length && payloadPart !== undefined ? readPayload(payloadPart) : undefined;
  const signature = signaturePart === undefined ? undefined : fromBase64Url(signaturePart);
  if (payload === undefined || signature === undefined || payloadPart === undefined) {
    return { ok: false, reason: ActivationRefusal.MALFORMED };
  }
  const subtle = options.subtle ?? globalThis.crypto.subtle;
  const signed = new TextEncoder().encode(payloadPart);
  if (!(await signatureVerifies(subtle, options.publicKey, signature, signed))) {
    return { ok: false, reason: ActivationRefusal.BAD_SIGNATURE };
  }
  if (payload.exp <= options.now) return { ok: false, reason: ActivationRefusal.EXPIRED };
  if (payload.origin !== options.origin)
    return { ok: false, reason: ActivationRefusal.WRONG_ORIGIN };
  if (!secureBridge(payload.bridge))
    return { ok: false, reason: ActivationRefusal.INSECURE_BRIDGE };
  return { ok: true, payload };
}

/**
 * Mint a ticket. For the service only: it holds the Ed25519 private key, and the key never leaves
 * it. Import a PKCS#8 key with `crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false,
 * ['sign'])`.
 */
export async function signActivationTicket(
  privateKey: SigningKey,
  payload: ActivationTicketPayload,
  subtle: Subtle = globalThis.crypto.subtle,
): Promise<string> {
  const payloadPart = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await subtle.sign(
    { name: ED25519 },
    privateKey,
    new TextEncoder().encode(payloadPart),
  );
  return `${payloadPart}${TICKET_SEPARATOR}${toBase64Url(new Uint8Array(signature))}`;
}
