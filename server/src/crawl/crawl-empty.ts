/**
 * Why a crawl clicked nothing.
 *
 * `stepsRun: 0` came back with no `error` and nothing else, so "the page had no controls" and "it had
 * 34 and none were clicked" were the same answer. Reported from a sweep on a page with 34 of them,
 * and not reproducible here — crawl drives the bench app correctly — so the honest move is to make
 * the zero carry its own diagnosis rather than guess at a cause.
 */

interface CrawlOutcome {
  interactiveFound: number;
  stepsRun: number;
  maxSteps: number;
  truncated: boolean;
}

export function crawlEmptyNote(outcome: CrawlOutcome): string | undefined {
  if (outcome.stepsRun > 0) return undefined;
  if (outcome.maxSteps <= 0) {
    return 'nothing was clicked because maxSteps is 0 — raise it to crawl at all';
  }
  if (0 === outcome.interactiveFound) {
    const capped = outcome.truncated
      ? ' The snapshot was also truncated, so controls past the cap were never seen — narrow `scope` and retry.'
      : '';
    return `no interactive controls were found on this page, so nothing was clicked — the crawl ran and found none, which is a result rather than a failure.${capped}`;
  }
  return (
    `${String(outcome.interactiveFound)} interactive controls were found and none of them were clicked. ` +
    `That is not an empty page, so something stopped the loop — report it with reticle_feedback, ` +
    `including this page's URL and one control's ref.`
  );
}
