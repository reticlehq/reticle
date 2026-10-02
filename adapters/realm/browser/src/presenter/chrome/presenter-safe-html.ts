/**
 * The two rules every panel that builds HTML from outside text has to obey.
 *
 * Shared rather than copied per panel: both are SECURITY rules, and a security rule that exists in
 * two files is a rule that gets fixed in one of them.
 */

/**
 * Escape text that came from outside this panel.
 *
 * A defect's `detail` is ultimately the CONTENT of somebody else's page, and these panels build
 * their DOM from an HTML string. Everything else they render is a number or a date; app-derived
 * text is where escaping has to arrive with the feature.
 */
export function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Whether a dashboard link is safe to render as a clickable href.
 *
 * The url arrives from `.reticle/cloud.json` — a file in somebody's repository, which means it is
 * INPUT. Escaping the quotes stops it breaking out of the attribute but does nothing about the
 * SCHEME, so `javascript:...` produced a link that ran code inside the developer's own application,
 * from a panel Reticle injected there. Only the two schemes a dashboard can actually live on are
 * allowed; anything else renders no link at all, which is the same state as an unlinked project and
 * therefore already a supported one.
 */
export function isSafeDashboardUrl(raw: string): boolean {
  try {
    const scheme = new URL(raw).protocol;
    return 'https:' === scheme || 'http:' === scheme;
  } catch {
    // Not a url at all. A relative path cannot address a dashboard on another origin, so there is
    // nothing to render and nothing lost by refusing it.
    return false;
  }
}
