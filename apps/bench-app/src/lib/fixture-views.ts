/**
 * The switch for test-only fixture views: `?fixture-views=1` in the URL.
 *
 * A view that exists only for an e2e spec still adds a link to the sidebar, and every snapshot of
 * the page then pays for it. The benchmark reads those snapshots, so two such links lowered its
 * efficiency by more than its tolerance. Without the switch the links are not rendered, and the
 * benchmark measures the same page it measured before these views existed. Put a new fixture view
 * behind this switch.
 */
const FIXTURE_VIEWS_PARAM = 'fixture-views';

export function areFixtureViewsEnabled(): boolean {
  if ('undefined' === typeof location) {
    return false;
  }
  return new URLSearchParams(location.search).has(FIXTURE_VIEWS_PARAM);
}
