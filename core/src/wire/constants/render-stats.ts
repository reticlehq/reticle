/**
 * The fields of the React adapter's `__reticle_renders` store (`RETICLE_RENDERS_STORE`) that the
 * server reads. The adapter writes them and the server reads them, so each name is one fact here.
 */
export const RenderStatsField = {
  /**
   * True when React has hydrated every server-rendered part of the page. False while a part has no
   * event handlers yet. Replay waits for true before step 1 (#1654).
   */
  HYDRATED: 'hydrated',
} as const;
export type RenderStatsField = (typeof RenderStatsField)[keyof typeof RenderStatsField];
