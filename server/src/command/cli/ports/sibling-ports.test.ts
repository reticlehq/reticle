/**
 * #261 remaining half: notice a listener on a well-known Reticle port we are not bound to, and
 * report it as an observation — never as "that is the daemon this app wants".
 */
import { describe, expect, it } from 'vitest';
import { RETICLE_DEFAULT_PORT } from '@reticlehq/core';
import {
  RETICLE_BENCH_PORT,
  WELL_KNOWN_RETICLE_PORTS,
  findOccupiedSiblings,
  siblingListenerNote,
  siblingPorts,
} from './sibling-ports.js';

describe('siblingPorts', () => {
  it('from the default daemon, the bench port is the sibling to probe', () => {
    expect(siblingPorts(RETICLE_DEFAULT_PORT)).toEqual([RETICLE_BENCH_PORT]);
  });

  it('from the bench daemon, the default port is the sibling to probe', () => {
    expect(siblingPorts(RETICLE_BENCH_PORT)).toEqual([RETICLE_DEFAULT_PORT]);
  });

  it('on an unrelated port, both well-known ports are siblings', () => {
    expect(siblingPorts(4411)).toEqual([...WELL_KNOWN_RETICLE_PORTS]);
  });

  it('never includes the port we ourselves bound', () => {
    for (const bound of WELL_KNOWN_RETICLE_PORTS) {
      expect(siblingPorts(bound)).not.toContain(bound);
    }
  });
});

describe('siblingListenerNote', () => {
  it('says nothing when no sibling is occupied — the common case must not gain a paragraph', () => {
    expect(siblingListenerNote(RETICLE_DEFAULT_PORT, [])).toBeUndefined();
  });

  it('names both ports and refuses the conclusion', () => {
    const note = siblingListenerNote(RETICLE_DEFAULT_PORT, [RETICLE_BENCH_PORT]);
    expect(note).toContain(':4460');
    expect(note).toContain(':4400');
    expect(note).toMatch(/may or may not be related/);
    // The constraint recorded on #261: a listener is not evidence it is the daemon this app wants.
    expect(note).not.toMatch(/SDK will dial|SDK is dialling/i);
    expect(note).not.toMatch(/the daemon this app wants/i);
    expect(note).not.toMatch(/so the app is connected to/i);
  });

  it('lists every occupied sibling rather than picking one and implying it is the cause', () => {
    const note = siblingListenerNote(4411, [RETICLE_DEFAULT_PORT, RETICLE_BENCH_PORT]);
    expect(note).toContain(':4400');
    expect(note).toContain(':4460');
  });
});

describe('findOccupiedSiblings', () => {
  it('returns only the well-known ports the probe says are listening, excluding our own', async () => {
    const occupied = await findOccupiedSiblings(RETICLE_DEFAULT_PORT, (port) =>
      Promise.resolve(port === RETICLE_BENCH_PORT),
    );
    expect(occupied).toEqual([RETICLE_BENCH_PORT]);
  });

  it('returns empty when nothing else is listening — including when our own port would match', async () => {
    const occupied = await findOccupiedSiblings(RETICLE_DEFAULT_PORT, (port) =>
      Promise.resolve(port === RETICLE_DEFAULT_PORT),
    );
    expect(occupied).toEqual([]);
  });
});
