/**
 * Turning errors into something we can COUNT without carrying anything anyone wrote.
 *
 * An error message is the most tempting thing to send and the most dangerous: it is where a selector,
 * a URL, a customer id, a file path, or a snippet of someone's app ends up. But "which error is
 * hurting people most" is genuinely the highest-value product question we can ask, and it needs
 * grouping — a thousand machines hitting the same defect have to collapse into one row before anyone
 * can rank it.
 *
 * A fingerprint gives us the grouping without the content: strip every variable part, keep the
 * skeleton, hash it. `no baseline named 'checkout-v3'` and `no baseline named 'login'` both become
 * the same fingerprint, and neither flow name leaves the machine. The output is a short hex string,
 * so even the skeleton is not readable on our side — it is an opaque group key, and its only power is
 * that identical failures share it.
 */
import { createHash } from 'node:crypto';

/**
 * The variable parts, replaced before hashing. Order matters: quoted strings go first, because a
 * quoted value often contains the very numbers and paths the later rules would only partly catch.
 */
const VARIABLE_PARTS: readonly RegExp[] = [
  // ── Identifiers and credentials FIRST ────────────────────────────────────────────────────────
  //
  // The rules below this block were written to make messages GROUPABLE — blank the variable parts so
  // the same defect hashes the same everywhere. Redaction was a side effect of that, and a side
  // effect is not a guarantee. A telemetry audit caught `bob@acme.com` arriving verbatim in
  // `crash_message`; probing further, API-key-shaped tokens survived intact and a JWT was only
  // half-masked. This function also feeds `session.errors[]` on EVERY session summary, so the
  // exposure was every session that logged an error naming a user, not a rare crash path.
  //
  // Order matters: these run before the generic patterns, because `\d+` and the hex rule would chew
  // a token into pieces that no longer match a credential shape while still leaking most of it —
  // which is exactly what happened to the JWT.
  /[\w.+-]+@[\w-]+\.[\w.-]+/g, // email addresses
  /\beyJ[\w-]*\.[\w-]*\.?[\w-]*/g, // JWTs (header segment is always base64 `eyJ`)
  /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|ghr|github_pat|xox[abposr]|AKIA|ASIA|glpat)[_-][A-Za-z0-9_-]{8,}/gi,
  // Anything else long enough and dense enough to be a secret rather than a word. The catch-all for
  // formats nobody here has seen: on a privacy boundary, unrecognised is not the same as safe.
  /\b[A-Za-z0-9_-]{24,}\b/g,
  // ── Then the grouping rules ──────────────────────────────────────────────────────────────────
  /"[^"]*"|'[^']*'|`[^`]*`/g, // quoted values — names, selectors, snippets
  /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, // URLs
  // Windows paths run to the end of the message: a directory name may hold a space, and
  // `C:\Users\Jane Doe\…` cut at the first space sent the surname.
  /(?:\\\\\?\\)?[A-Za-z]:[\\/].*$/g,
  /~[\\/]\S*/g, // home-relative paths
  /(?:\/[\w.-]+){2,}\/?/g, // POSIX-ish paths
  /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, // IPv4 (+ port)
  /\b[\w-]+(?:\.[\w-]+)+\b/g, // hostnames and other dotted names
  /\b[0-9a-f]{8,}\b/gi, // hex ids, hashes, uuids-without-dashes
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, // uuids
  /\d+/g, // any remaining number — ports, counts, timeouts
];

/**
 * How much of a message is even looked at.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────────────
 * Several patterns above are polynomial-ReDoS shapes, and CodeQL flagged this function `high`:
 * `[\w.+-]+@` is the clearest — on a long run of `+` with no `@` anywhere, the engine retries the
 * `+` from every start position and rescans to the end each time, so the cost is quadratic in the
 * length of the run. `(?:\/[\w.-]+){2,}` and the 24-plus-character secret catch-all have the same
 * shape. The input is an error message, and an error message is the most attacker-influenceable
 * string this daemon handles: it comes from the page under test, which is somebody's app.
 *
 * The cap is the fix rather than twelve rewritten regexes, because these patterns are a PRIVACY
 * boundary. Rewriting each one to be provably linear risks changing what gets redacted, and a
 * mistake there leaks a credential rather than costing milliseconds.
 *
 * Capping the INPUT cannot leak anything the old code did not, and that is what makes it safe: the
 * output was already `.slice(0, 200)`, so everything past this bound was being discarded after
 * being scanned. Now it is discarded without being scanned. 1024 is five times the output bound,
 * which leaves ample room for the masking to shrink text before the 200 chars are taken.
 *
 * The wire caps an error at `MAX_ERROR_LENGTH` (4096) so the worst case was bounded already; this
 * is about the paths that do not come off the wire, and about not relying on a limit set elsewhere
 * for a reason unrelated to this one.
 */
const MAX_SKELETON_INPUT = 1024;

/** Variable parts blanked, whitespace collapsed, length bounded. The GROUPING basis; never sent. */
function redactedShape(message: string): string {
  let skeleton = message.slice(0, MAX_SKELETON_INPUT);
  for (const pattern of VARIABLE_PARTS) skeleton = skeleton.replace(pattern, '*');
  return skeleton.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Sentences Reticle itself authors, and the fixed text sent for each. The OUTPUT is always the
 * label, never the matched message, so text appended to one of ours cannot ride along.
 */
const RETICLE_MESSAGES: readonly { readonly match: RegExp; readonly label: string }[] = [
  { match: /^no browser session connected\b/i, label: 'no browser session connected' },
  { match: /^multiple sessions connected\b/i, label: 'multiple sessions connected' },
  { match: /^no connected session with id\b/i, label: 'no connected session with id *' },
  { match: /^no baseline named\b/i, label: 'no baseline named *' },
  { match: /^no (?:active|compiled) recording named\b/i, label: 'no recording named *' },
  { match: /no longer resolves to an element/i, label: 'ref * no longer resolves to an element' },
  { match: /^session disconnected$/i, label: 'session disconnected' },
  { match: /^command '[^']*' timed out after\b/i, label: 'command * timed out after *' },
  {
    match: /did not resolve in current page/i,
    label: 'flow step * did not resolve in current page',
  },
  {
    match: /potentially destructive (?:\w+ )*(?:action|tool) blocked/i,
    label: 'potentially destructive action blocked',
  },
  { match: /^pairing token is required\b/i, label: 'pairing token is required' },
  { match: /no <option> with value/i, label: 'no <option> with value *' },
  { match: /cannot hover without a real pointer/i, label: 'cannot hover without a real pointer' },
  { match: /browser pool (?:unavailable|is shut down)/i, label: 'browser pool unavailable' },
  { match: /Chromium is not installed/i, label: 'Chromium is not installed' },
  { match: /^act failed$/i, label: 'act failed' },
];

/** A Node error code (`ENOENT`, `ERR_INVALID_ARG_TYPE`): an identifier Node defines, never data. */
const NODE_ERROR_CODE = /\b(?:E[A-Z]{2,}|ERR_[A-Z_]{2,})\b/;
/** The built-in error classes. A custom class name is the app's own word, so it is not kept. */
const BUILTIN_ERROR_CLASS =
  /^(?:Error|TypeError|RangeError|SyntaxError|ReferenceError|EvalError|URIError|AggregateError|AbortError|TimeoutError|DOMException|ZodError)\b/;

/**
 * What an error message may say on the wire, and it is ALLOW-listed: a sentence Reticle authors
 * (sent as our own fixed label), else the bare Node error code or built-in class plus the
 * fingerprint, else the fingerprint alone.
 *
 * It used to be the message with known-variable parts blanked, which is a deny-list, and a
 * deny-list loses: a hostname after `getaddrinfo ENOTFOUND`, a Windows home directory with a space
 * in it, a `~` path and a person's name in free text all reached the wire. Nothing written by
 * anybody else survives this function, because it never echoes its input.
 */
export function errorSkeleton(message: string): string {
  const head = message.slice(0, MAX_SKELETON_INPUT).trim();
  for (const { match, label } of RETICLE_MESSAGES) if (match.test(head)) return label;
  const fingerprint = `#${fingerprintError(message)}`;
  const code = BUILTIN_ERROR_CLASS.exec(head)?.[0] ?? NODE_ERROR_CODE.exec(head)?.[0];
  return code === undefined ? fingerprint : `${code} ${fingerprint}`;
}

/** A stable, opaque group key for an error message. Same defect ⇒ same key, on every machine. */
export function fingerprintError(message: string): string {
  return createHash('sha256').update(redactedShape(message)).digest('hex').slice(0, 12);
}

/**
 * Frames from a stack trace that belong to RETICLE, reduced to `basename:line`.
 *
 * A crash stack is mostly the user's own application and node internals; neither is ours to collect,
 * and the user's frames are the ones that would carry their directory layout and module names. Only
 * frames inside a `@reticlehq/*` package or a `reticle` dist path survive, and even those keep just
 * the file basename — enough to point a maintainer at the right file, never enough to describe
 * anyone's machine.
 */
export function reticleFrames(stack: string): string[] {
  const frames: string[] = [];
  for (const line of stack.split('\n')) {
    if (!/@reticlehq[/\\]|[/\\]reticle[/\\]dist[/\\]/.test(line)) continue;
    const location = line.match(/([\w.-]+\.(?:js|mjs|cjs|ts)):(\d+)/);
    if (null === location) continue;
    // `at Object.runTool (/path/to/invoke-tool.js:88:3)` → `runTool`. The function name is half the
    // value of a frame in an RCA — "it died in act-tools.js" narrows to a file, "it died in
    // resolveAnchor" names the thing that broke. Anonymous frames just report the location.
    const fn = line.match(/at\s+(?:async\s+)?(?:new\s+)?([\w.$<>[\]]+)\s+\(/)?.[1];
    const where = `${location[1] ?? ''}:${location[2] ?? ''}`;
    // `Object.` / `Module.` prefixes are V8 noise that make the same function look like two.
    const name = fn?.replace(/^(?:Object|Module|Function)\./, '');
    frames.push(name === undefined || '' === name ? where : `${name}@${where}`);
  }
  return frames;
}

/** How many of our own frames to carry. The innermost few are where the defect is. */
export const MAX_REPORTED_FRAMES = 12;

/**
 * A crash fingerprint from the error's type and its Reticle-owned frames. Falls back to the message
 * skeleton when a stack has no Reticle frames at all (a crash from deep inside a dependency), so a
 * crash is never dropped for lack of a clean attribution.
 */
export function fingerprintCrash(errorType: string, stack: string, message: string): string {
  const frames = reticleFrames(stack);
  const basis =
    frames.length > 0
      ? `${errorType}|${frames.join('|')}`
      : `${errorType}|${redactedShape(message)}`;
  return createHash('sha256').update(basis).digest('hex').slice(0, 12);
}

/** The error's constructor name (`TypeError`), or `Unknown` for a thrown non-Error. */
export function errorTypeOf(error: unknown): string {
  if (error instanceof Error) return error.constructor.name.slice(0, 64);
  return 'Unknown';
}
