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
  /(?:\/[\w.-]+){2,}\/?/g, // POSIX-ish paths
  /[A-Za-z]:\\[^\s]*/g, // Windows paths
  /\b[0-9a-f]{8,}\b/gi, // hex ids, hashes, uuids-without-dashes
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, // uuids
  /\d+/g, // any remaining number — ports, counts, timeouts
];

/** The skeleton of a message: variable parts blanked, whitespace collapsed, length bounded. */
export function errorSkeleton(message: string): string {
  let skeleton = message;
  for (const pattern of VARIABLE_PARTS) skeleton = skeleton.replace(pattern, '*');
  return skeleton.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** A stable, opaque group key for an error message. Same defect ⇒ same key, on every machine. */
export function fingerprintError(message: string): string {
  return createHash('sha256').update(errorSkeleton(message)).digest('hex').slice(0, 12);
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
      : `${errorType}|${errorSkeleton(message)}`;
  return createHash('sha256').update(basis).digest('hex').slice(0, 12);
}

/** The error's constructor name (`TypeError`), or `Unknown` for a thrown non-Error. */
export function errorTypeOf(error: unknown): string {
  if (error instanceof Error) return error.constructor.name.slice(0, 64);
  return 'Unknown';
}
