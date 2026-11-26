import { describe, expect, it } from 'vitest';

import { nextLookMs } from './peer.js';

describe('nextLookMs', () => {
  it('looks at a small window as often as it was asked to', () => {
    expect(nextLookMs(250, 8)).toBe(250);
  });

  it('looks at a large window less often, so the looks take a tenth of the time at most', () => {
    expect(nextLookMs(250, 340)).toBe(3400);
  });
});
