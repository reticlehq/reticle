/**
 * How a project's stable identity is SPELLED. The rule, once, for everyone who has to produce it.
 *
 * projectId is what scopes a session to an app, so the build plugin's stamp and what `reticle init`
 * records into `.reticle.json` have to agree exactly or the app's sessions land under a project
 * nobody is looking at. It was maintained as two byte-identical copies — `slugifyPackageName`,
 * `shortHash` and `deriveProjectId` in both `@reticlehq/vite-plugin` and `@reticlehq/server` — held
 * in sync by a comment asking the next contributor to keep them identical. They still were, but
 * nothing would have failed on the day they were not: no test compares them, and the symptom of a
 * mismatch is a session quietly filed under the wrong id.
 *
 * The hashing stays with the callers because it needs `node:crypto`, and core is isomorphic — the
 * same split `discoverDaemonPort` already uses, where core owns the selection rule and each package
 * owns its own filesystem plumbing.
 */

/** How much of the digest goes into the id. Short enough to read, long enough not to collide. */
export const PROJECT_ID_HASH_LENGTH = 8;

/** Fallback id base when neither the package name nor the folder name yields anything usable. */
const FALLBACK_PROJECT_BASE = 'app';

/** `@acme/web` → `acme-web`; non-alphanumerics collapse to single dashes; edges trimmed. */
export function slugifyPackageName(name: string): string {
  const collapsed = name
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9]+/g, '-');
  return trimChar(collapsed, '-');
}

/**
 * Trim a repeated character from both ends without a regex.
 *
 * `/^-+|-+$/` is an anchored quantifier, and on a string of many dashes the engine retries the
 * match from every position: linear input, quadratic work. Nothing hostile reaches here today (the
 * inputs are the user's own package name and path), which is exactly why it would have gone
 * unnoticed if something ever did. Two index walks cost nothing and cannot backtrack.
 */
function trimChar(value: string, char: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === char) start += 1;
  while (end > start && value[end - 1] === char) end -= 1;
  return value.slice(start, end);
}

/**
 * The last segment of a path — `node:path`'s `basename`, reimplemented because core may not import
 * Node. Handles both separators so a Windows root produces the same id as a POSIX one.
 */
function pathTail(path: string): string {
  // Same reason as `trimChar`: an anchored `+` over a run of separators backtracks quadratically.
  let end = path.length;
  while (end > 0 && ('/' === path[end - 1] || '\\' === path[end - 1])) end -= 1;
  const trimmed = path.slice(0, end);
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return -1 === cut ? trimmed : trimmed.slice(cut + 1);
}

/**
 * The stable projectId: a slug of the package name (falling back to the root's folder name, then
 * `app`), plus a short fingerprint of the absolute root so two checkouts of the same package are
 * still distinct.
 *
 * `hash` is injected rather than imported — it is the one impure, Node-only part, and passing it in
 * is what lets this rule live in the isomorphic package with the callers that own `node:crypto`.
 */
export function projectIdFrom(
  pkgName: string | undefined,
  rootPath: string,
  hash: (input: string) => string,
): string {
  const fromName = pkgName !== undefined ? slugifyPackageName(pkgName) : '';
  const base =
    fromName.length > 0
      ? fromName
      : slugifyPackageName(pathTail(rootPath)) || FALLBACK_PROJECT_BASE;
  return `${base}-${hash(rootPath)}`;
}
