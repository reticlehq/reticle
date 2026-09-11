import { describe, expect, it } from 'vitest';
import { FLOW_FILE_VERSION, FlowStatus, selectFlows, type FlowFile } from '../index.js';

/**
 * Choosing which flows a run actually replays.
 *
 * Two jobs, and they must not be confused in the answer. SELECTION is what the caller asked for.
 * EXCLUSION is what the suite refused to run despite being asked. A run that silently returns fewer
 * flows than were selected is a run whose coverage nobody can account for, so the excluded ones come
 * back named rather than subtracted.
 */
const flow = (name: string, over: Partial<FlowFile> = {}): FlowFile => ({
  version: FLOW_FILE_VERSION,
  name,
  createdAt: 0,
  steps: [],
  ...over,
});

const HELD = { reason: 'deploy API 500s', since: '2026-09-12', owner: 'alice' };

const ALL = [
  flow('login', { labels: ['smoke', 'auth'] }),
  flow('checkout', { labels: ['smoke', 'money'] }),
  flow('refund', { labels: ['money'] }),
  flow('sweep', { status: FlowStatus.QUARANTINED, quarantine: HELD, labels: ['smoke'] }),
  flow('draft-thing', { status: FlowStatus.DRAFT }),
];

describe('selecting the flows a run replays', () => {
  it('runs everything active when nothing is asked for', () => {
    const chosen = selectFlows(ALL, {});
    expect(chosen.run.map((f) => f.name)).toEqual(['login', 'checkout', 'refund', 'draft-thing']);
  });

  it('narrows to a label', () => {
    expect(selectFlows(ALL, { labels: ['money'] }).run.map((f) => f.name)).toEqual([
      'checkout',
      'refund',
    ]);
  });

  it('treats several labels as ANY, not ALL — a set is a union of what you named', () => {
    expect(selectFlows(ALL, { labels: ['auth', 'money'] }).run.map((f) => f.name)).toEqual([
      'login',
      'checkout',
      'refund',
    ]);
  });

  it('narrows to explicit names', () => {
    expect(selectFlows(ALL, { names: ['refund'] }).run.map((f) => f.name)).toEqual(['refund']);
  });

  it('EXCLUDES a quarantined flow even when it matches the selection', () => {
    // `sweep` carries the `smoke` label. Asking for smoke must not drag a held flow back in.
    const chosen = selectFlows(ALL, { labels: ['smoke'] });
    expect(chosen.run.map((f) => f.name)).toEqual(['login', 'checkout']);
    expect(chosen.quarantined).toEqual(['sweep']);
  });

  it('names what it excluded rather than quietly returning fewer', () => {
    // The number that matters is not how many ran — it is how many were asked for and did not.
    expect(selectFlows(ALL, {}).quarantined).toEqual(['sweep']);
  });

  it('reports a name that matched nothing, instead of running an empty suite', () => {
    // Silently passing over a typo is how "all green" comes to mean "nothing ran".
    const chosen = selectFlows(ALL, { names: ['chekout'] });
    expect(chosen.run).toEqual([]);
    expect(chosen.unmatched).toEqual(['chekout']);
  });

  it('reports a label that matched nothing', () => {
    expect(selectFlows(ALL, { labels: ['nightly'] }).unmatched).toEqual(['nightly']);
  });
});
