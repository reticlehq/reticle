/**
 * The document's OWN request and a document-INITIATED subresource are different evidence.
 *
 * `installNavigation` reports the request that fetched this document, read once from
 * `PerformanceNavigationTiming` and stamped `NetInitiator.DOCUMENT`. The resource-timing observer
 * reports subresources the document pulled in — `link`, `css`, `img`, `script`, `manifest`, `other`
 * — and the presence of one of THOSE is what proves that observer is alive on this page.
 *
 * The trap this pins: `"document"` reads like it belongs in `DOCUMENT_INITIATORS`, and putting it
 * there would be actively harmful. A navigation entry exists on every page with the Navigation
 * Timing API, including pages where `PerformanceObserver` never fired — so counting it as liveness
 * would flip the honest "I cannot tell a missing request from an unobserved one" into a confident
 * `assertion_failed`. That downgrade exists because an assert over `/favicon.ico` came back
 * `verified: "no"` while curl showed it answering 200, and an agent that trusts a false red goes and
 * "fixes" working code.
 *
 * Two channels, two meanings, and one must not be allowed to vouch for the other.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NetInitiator } from '@reticlehq/core';

const SOURCE = readFileSync(join(import.meta.dirname, 'predicate-eval.ts'), 'utf8');
const SET_NAME = 'DOCUMENT_INITIATORS';

/** The literal members of the liveness set, read from the source that declares them. */
function livenessInitiators(): string[] {
  const block = new RegExp(
    `const ${SET_NAME}: ReadonlySet<string> = new Set\\(\\[([^\\]]*)\\]`,
  ).exec(SOURCE);
  const body = block?.[1];
  if (body === undefined) throw new Error(`${SET_NAME} not found — has it been renamed?`);
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
}

describe('the navigation initiator is not resource-timing liveness', () => {
  it('finds the set at all — a vacuous guard is not a guard', () => {
    expect(livenessInitiators().length).toBeGreaterThan(0);
  });

  it('does NOT count the document own request as proof the subresource observer is live', () => {
    expect(
      livenessInitiators(),
      `"${NetInitiator.DOCUMENT}" is available on every page with Navigation Timing, including ` +
        'pages where PerformanceObserver never fired. Counting it as liveness turns an honest ' +
        'inconclusive into a false red over favicons and fonts.',
    ).not.toContain(NetInitiator.DOCUMENT);
  });

  it('still counts the subresource initiators, which only that observer produces', () => {
    expect(livenessInitiators()).toEqual(
      expect.arrayContaining(['link', 'css', 'img', 'script', 'manifest']),
    );
  });
});
