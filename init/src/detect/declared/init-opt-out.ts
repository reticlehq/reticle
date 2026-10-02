/**
 * An explicit "do not instrument this" in a file `init` would otherwise edit.
 *
 * `init` runs unattended, usually by an agent, in a repo it has just met. Reported from a monorepo
 * audit: it added the plugin to an app whose `vite.config` carried a comment saying Reticle was
 * deliberately excluded, and in the same run appended to `CLAUDE.md` — the file every agent in that
 * repo reads first. The reporter reverted all of it.
 *
 * A tool that overrides an explicit "no" is one nobody lets near a monorepo twice, and a SILENT
 * override is worse than a refusal because the file it edited is the file that said not to.
 *
 * One marker for every surface. A user should learn `@reticle-ignore` once, not once per file type.
 */

/** The marker, exported so no caller restates the string. */
export const OPT_OUT_MARKER = '@reticle-ignore';

/**
 * Matched as a whole token so neighbouring text cannot trigger it.
 *
 * `@reticle-ignored-paths` in a doc link, or prose mentioning reticle and ignore in one sentence,
 * must not read as an opt-out — a false positive here silently declines to instrument an app that
 * wanted instrumenting, which is the same silent-wrong-outcome failure in the other direction.
 *
 * Case-insensitive: a marker people type by hand gets typed how they like, and refusing
 * `@Reticle-Ignore` would be a rule that exists only to be tripped over.
 */
const OPT_OUT_TOKEN = new RegExp(`${OPT_OUT_MARKER}(?![\\w-])`, 'i');

/** True when `source` carries the opt-out marker. Absent or empty source is not an opt-out. */
export function hasOptOut(source: string | undefined): boolean {
  return source !== undefined && OPT_OUT_TOKEN.test(source);
}
