import { describe, expect, it } from 'vitest';
import { NO_EDITS_OBSERVED, isSameEditEpoch } from './edit-epoch.js';

describe('isSameEditEpoch', () => {
  it('counts evidence from the current epoch as current', () => {
    expect(isSameEditEpoch(3, 3)).toBe(true);
  });

  it('counts evidence from an earlier epoch as NOT current', () => {
    expect(isSameEditEpoch(2, 3)).toBe(false);
    expect(isSameEditEpoch(NO_EDITS_OBSERVED, 3)).toBe(false);
  });

  it('counts UNSTAMPED evidence as current only while no edit has been observed', () => {
    // Older SDKs and pages with no hot channel stamp nothing; while current is unknown or zero,
    // reading that as foreign would silence real contradictions.
    expect(isSameEditEpoch(undefined, undefined)).toBe(true);
    expect(isSameEditEpoch(undefined, NO_EDITS_OBSERVED)).toBe(true);
    expect(isSameEditEpoch(2, undefined)).toBe(true);
  });

  it('counts UNSTAMPED evidence as foreign once an edit has been observed', () => {
    // Omitting epoch 0 on the wire left pre-edit events looking current after the first hot update.
    expect(isSameEditEpoch(undefined, 1)).toBe(false);
    expect(isSameEditEpoch(undefined, 3)).toBe(false);
  });

  it('counts everything as current while no edit has been observed', () => {
    expect(isSameEditEpoch(NO_EDITS_OBSERVED, NO_EDITS_OBSERVED)).toBe(true);
  });
});
