/**
 * Every telemetry event kind appears on both telemetry pages.
 *
 * THE DEFECT THIS EXISTS FOR: `onboarding_step` shipped collected and undocumented. It was absent
 * from `docs/telemetry-events.mdx`, the contributor reference whose own opening line promises
 * "every event Reticle emits is listed below", and absent from `docs/telemetry.md`, the page that
 * tells a user what is collected about them. Found on 2026-09-22 by diffing `TelemetryEventKind`
 * against the two files by hand, while answering a question about the setup funnel -- which is the
 * funnel that event exists to measure, so the one event nobody could read about was the one that
 * answered the question being asked.
 *
 * Both pages, because they fail differently and only one of them is a transparency problem: an
 * undocumented event on the contributor page is a reader who cannot find the schema, and an
 * undocumented event on the user page is data leaving a machine with no public account of it.
 *
 * A name match, deliberately. Asserting the wire name appears somewhere on the page is weak, and it
 * is exactly as strong as the claim being made: that the name is findable. Anything stricter would
 * be a format rule dressed up as a coverage rule, and would go red on a rewrite that lost nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TelemetryEventKind } from '@reticlehq/core/telemetry';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '@/machine/repo-root.js';

/** The pages that promise to list every kind, and what each promises to a different reader. */
const PAGES = [
  { path: 'docs/telemetry-events.mdx', reader: 'a contributor looking for the schema' },
  { path: 'docs/telemetry.md', reader: 'a user asking what leaves their machine' },
] as const;

const KINDS: readonly string[] = Object.values(TelemetryEventKind);

describe('every telemetry event kind is documented', () => {
  it('finds the kinds at all, so a pass is not a pass over nothing', () => {
    expect(KINDS.length).toBeGreaterThan(10);
  });

  for (const page of PAGES) {
    it(`${page.path} names every kind, for ${page.reader}`, () => {
      const text = readFileSync(join(REPO_ROOT, page.path), 'utf8');
      const missing = KINDS.filter((kind) => !text.includes(kind));
      expect(
        missing,
        `${page.path} does not mention: ${missing.join(', ')}. An event that is collected and ` +
          'undocumented is either a reader who cannot find its schema or data leaving a machine ' +
          'with no public account of it, depending on which page this is.',
      ).toEqual([]);
    });
  }
});
