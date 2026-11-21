/**
 * The fields of the React adapter's `__reticle_renders` store (`RETICLE_RENDERS_STORE`) that the
 * server reads. The adapter writes them and the server reads them, so each name is one fact here.
 */
export const RenderStatsField = {
  /** The page's `HydrationState`. Replay waits while it is `pending` (#1654). */
  HYDRATION: 'hydration',
} as const;
export type RenderStatsField = (typeof RenderStatsField)[keyof typeof RenderStatsField];

/**
 * Has React hydrated every server-rendered part of the page? The adapter reads it from React's own
 * fibers. Only `pending` makes replay wait: the other three give no reason to.
 */
export const HydrationState = {
  /** The adapter found no React root on the page. Nothing there waits for hydration. */
  NONE: 'none',
  /** A React root, or a Suspense or Activity boundary in it, is still dehydrated. */
  PENDING: 'pending',
  /** React rendered, and no part of the page waits for hydration. */
  DONE: 'done',
  /** The adapter could not read the tree to the end. It does not claim `done`. */
  UNKNOWN: 'unknown',
} as const;
export type HydrationState = (typeof HydrationState)[keyof typeof HydrationState];
