import { describe, expect, it } from 'vitest';
import { assertSource } from './assert-source.js';

/**
 * A failure nobody could have made true must not name a file.
 *
 * `assertSource` falls back to the last driven control for a RED whose predicate has no DOM clause —
 * right when the app genuinely declined to do something, and actively wrong when the verdict is
 * `inconclusive`, which means precisely that nothing was proven and nobody could have proven it.
 *
 * Reported against a wedged Next.js dev server: the route verdict named
 * `components/.../header.tsx:53` and the reporter nearly filed "the header Sign Up link is broken".
 * A file:line reads as a precise, well-attributed finding; attaching one to a reading that proves
 * nothing sends the investigation into correct code.
 *
 * Gated on `inconclusive` rather than on the route oracle specifically, because every producer of an
 * inconclusive verdict has the same problem — a throttled tab, a superseded window, an unreadable
 * locator. One guard where all of them route through.
 */
describe('an inconclusive failure carries no file:line', () => {
  it('withholds the last act’s source when nothing could have been proven', () => {
    const source = assertSource({
      predicate: { kind: 'route', pathname: '/dashboard' },
      evidence: undefined,
      pass: false,
      lastActSource: 'components/header.tsx:53',
      inconclusive: 'the server has not answered',
    });
    expect(source, 'a pointer here reads as a finding about that file').toBeUndefined();
  });

  it('still points at the last act for an ordinary RED', () => {
    const source = assertSource({
      predicate: { kind: 'route', pathname: '/dashboard' },
      evidence: undefined,
      pass: false,
      lastActSource: 'components/header.tsx:53',
    });
    expect(source, 'the app really did decline — this is the case the fallback exists for').toBe(
      'components/header.tsx:53',
    );
  });
});
