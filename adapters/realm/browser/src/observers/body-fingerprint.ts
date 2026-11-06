import { fnv1a } from '@reticlehq/core';

/**
 * The per-page salt for text-body fingerprints: drawn once when the observer loads and never
 * written anywhere — not to the journal, not to the wire. Only hashes salted with it leave the
 * page, so a reader of the journal cannot brute-force a short value back out of a fingerprint:
 * without the salt, the same body hashes to something else. Two loads of a page draw different
 * salts, so fingerprints are comparable only within one page session, which is the window the
 * duplicate-request rule judges.
 */
let pageSalt: string | undefined;

function bodySalt(): string {
  if (pageSalt === undefined) {
    pageSalt = drawSalt();
  }
  return pageSalt;
}

function drawSalt(): string {
  try {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // No CSPRNG at hand: still a per-page value nobody else knows, just a weaker one.
    return `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * A body's canonical text: its JSON structure with keys sorted and values kept, so two sends
 * of the same payload canonicalize identically however the sender ordered its keys, and two
 * payloads that differ in any value canonicalize differently. Only ever fed to the salted
 * hash; the canonical text itself never leaves this function.
 */
function canonicalOf(value: unknown): string {
  if (null === value) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalOf).join(',')}]`;
  if ('object' === typeof value) {
    const fields = value as Record<string, unknown>;
    return `{${Object.keys(fields)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalOf(fields[key])}`)
      .join(',')}}`;
  }
  if ('string' === typeof value) return JSON.stringify(value);
  if ('number' === typeof value || 'boolean' === typeof value) return String(value);
  return OTHER_VALUE;
}

/**
 * The canonical marker for a value JSON cannot produce (undefined, a function, a symbol).
 * `canonicalOf` is only ever fed parsed JSON, so this is unreachable in practice; it exists
 * to keep the function total, mirroring the shape projection's `OTHER` token.
 */
const OTHER_VALUE = '?';

/**
 * The fingerprint of a text body, JSON or not: a salted hash of its canonical form (#1521).
 *
 * The shape-and-length discriminator used for the other body kinds cannot tell two payloads
 * apart when their values share types and total length — the normal case for a command-bus
 * endpoint, where one URL serves many commands that differ only in a short name — so
 * unrelated calls were grouped as one write fired twice. Hashing the canonical body
 * separates them, and the per-page salt keeps the hash from becoming a copy of the body for
 * short values: a journal reader who guesses a value cannot confirm the guess without the
 * salt, which never leaves the page.
 *
 * Form and form-urlencoded bodies keep the shape fingerprint (`fingerprintBody`): their
 * values are credentials and uploads as often as commands, and their keys-only rule is a
 * separate, tested decision.
 */
export function fingerprintTextBody(text: string): string {
  let canonical: string;
  try {
    canonical = `json:${canonicalOf(JSON.parse(text) as unknown)}`;
  } catch {
    canonical = `text:${text}`;
  }
  return fnv1a(`${bodySalt()}#${canonical}`);
}
