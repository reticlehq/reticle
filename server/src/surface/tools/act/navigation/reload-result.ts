/**
 * What `navigate { reload: true }` reports.
 *
 * It answered a bare `{ ok: true }`, while the URL branch of the same tool returns `confirmed: false`
 * plus a note — because `ok` means the browser accepted the instruction, not that the page arrived.
 * Identical semantics, one branch disclosing them and one not, and the silent one is the path most
 * likely to need the caveat: a reload tears the SDK down, and a caller that acts on `ok: true` hits
 * the window before it comes back.
 *
 * The permanent session loss reported alongside this is fixed separately — session-continuity.ts
 * remembers the id in sessionStorage so a reload rejoins the SAME session instead of appearing as a
 * new one. This is the remaining half: saying that the page is not back yet.
 */

/** The reload's own disclosure — the same shape and the same advice the URL branch gives. */
const RELOAD_NOTE =
  'ok means the reload was DISPATCHED, not that the page came back — the SDK is torn down by the ' +
  'reload itself, so nothing here can see the new document yet. Call reticle_sessions to confirm ' +
  'the session reconnected before acting; the session id is preserved across a reload, so it will ' +
  'be the same one.';

/**
 * What a CONFIRMED reload says. The page re-announced itself under the same id before this returned,
 * so the next call is safe — which is the whole reason the tool now waits instead of advising.
 */
const RELOAD_RECONNECTED_NOTE =
  'the page came back and re-announced itself under the same session id, so this session is live ' +
  'again — no re-selection needed. Anything captured before the reload is gone with the old document.';

/**
 * `waitedMs` is the budget that expired, reported on `confirmed:false` for the same reason the URL
 * branch reports it (navigate-result.ts): so "Reticle stopped waiting" is distinguishable from "the
 * page never came back", and the fix — a larger `timeout_ms` — is visible in the result.
 */
export function reloadResult(
  reconnected: boolean,
  waitedMs: number,
  hard?: HardReload,
): Record<string, unknown> {
  const base = reconnected
    ? { ok: true, confirmed: true, note: RELOAD_RECONNECTED_NOTE }
    : { ok: true, confirmed: false, waitedMs, note: RELOAD_NOTE };
  if (hard === undefined) {
    return base;
  }
  return { ...base, hardReload: hard, note: `${base.note} ${HARD_RELOAD_NOTE[hard]}` };
}

/**
 * How a `hard` reload reached the page (#1785). A leased tab reloads through the browser with the
 * cache ignored. Any other tab can only fetch its document again, so its modules can be stale.
 */
export const HardReload = {
  CACHE_IGNORED: 'cache_ignored',
  DOCUMENT_ONLY: 'document_only',
} as const;
export type HardReload = (typeof HardReload)[keyof typeof HardReload];

const HARD_RELOAD_NOTE: Readonly<Record<HardReload, string>> = {
  [HardReload.CACHE_IGNORED]:
    'The browser reloaded with its cache ignored, so every script and module was fetched again.',
  [HardReload.DOCUMENT_ONLY]:
    'This tab is not a lease, so only the document was fetched again. Scripts and modules can still come from the browser cache. To fetch them again, reload the tab in the browser with Cmd+Shift+R, or take a lease with reticle_lease.',
};

/** The `hardReload` field for a reload, or nothing when the call did not ask for `hard`. */
export function hardReloadOf(hard: boolean, throughBrowser: boolean): HardReload | undefined {
  if (!hard) {
    return undefined;
  }
  return throughBrowser ? HardReload.CACHE_IGNORED : HardReload.DOCUMENT_ONLY;
}
