/**
 * Write Reticle's own page UI as HTML on a page that requires Trusted Types.
 *
 * Such a page (Slack is one) refuses a plain string written to `innerHTML`, and the browser throws.
 * Each HTML write of the HUD and the annotator goes through here. When the page has Trusted Types,
 * the string passes through a policy named `reticle`. It is a named policy, never the `default` one,
 * so the page's own writes stay under the page's rules.
 *
 * A page whose CSP does not allow a policy named `reticle` refuses its creation, and the write throws
 * as before. `connect()` catches that, so the page UI is missing and the session still connects.
 */

/** The name of Reticle's Trusted Types policy. A page CSP can allow it by name: `trusted-types reticle`. */
export const TRUSTED_TYPES_POLICY = 'reticle';

interface HtmlPolicy {
  createHTML(html: string): unknown;
}

interface TrustedTypesApi {
  createPolicy(name: string, rules: { createHTML: (html: string) => string }): HtmlPolicy;
}

let policy: HtmlPolicy | undefined;

/** The HTML for a write: a TrustedHTML when the page has Trusted Types, else the string itself. */
export function trustedHtml(html: string): string {
  const api = (globalThis as { trustedTypes?: TrustedTypesApi }).trustedTypes;
  if (api === undefined) {
    return html;
  }
  policy ??= api.createPolicy(TRUSTED_TYPES_POLICY, { createHTML: (value) => value });
  // A TrustedHTML is accepted wherever a string is; the DOM types only know the string.
  return policy.createHTML(html) as string;
}

/** `el.innerHTML = html`, on a page with or without Trusted Types. */
export function setHtml(el: Element, html: string): void {
  el.innerHTML = trustedHtml(html);
}
