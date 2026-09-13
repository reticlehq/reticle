/**
 * Keep a tab's session id across a reload.
 *
 * The id was minted fresh on every `connect()`. A reload is a new document, so the page came back as
 * a NEW session while the agent still held the old id — and every call after
 * `reticle_navigate { reload: true }` was refused with "no browser session connected". Reported on 6
 * of 6 apps; a reload is the most ordinary thing an agent does.
 *
 * `sessionStorage` is exactly the right scope: it survives reloads and same-tab navigations, and is
 * NOT shared with another tab of the same app — so two tabs stay two sessions, which is what the
 * multi-session tooling assumes.
 *
 * An explicit id still wins. `connect({ session })` and the `__reticle_session` URL param a lease
 * stamps are callers ASSERTING an identity, not asking for one; they are also remembered, so a
 * leased tab that reloads rejoins its own lease.
 */

/** Where the id lives. Namespaced like the URL param it mirrors. */
const STORAGE_KEY = '__reticle_session';

export function rememberSessionLabel(
  explicit: string | undefined,
  store: Storage | undefined,
  generate: () => string,
): string {
  const read = (): string | undefined => {
    try {
      const value = store?.getItem(STORAGE_KEY);
      return value !== null && value !== undefined && value.length > 0 ? value : undefined;
    } catch {
      return undefined; // a sandboxed iframe throws on access; a session must still start
    }
  };
  const write = (value: string): void => {
    try {
      store?.setItem(STORAGE_KEY, value);
    } catch {
      /* same: never block connect on storage */
    }
  };
  // `explicit` may be '' — resolveSessionLabel yields that for "none given" — and `??` would take it.
  const asked = explicit !== undefined && explicit.length > 0 ? explicit : undefined;
  const chosen = asked ?? read() ?? generate();
  write(chosen);
  return chosen;
}
