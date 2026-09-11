import { describe, expect, it } from 'vitest';
import { IntentState, NO_EDITS_OBSERVED, type Intent } from '@reticlehq/core';
import { isChangeUndeclared } from './undeclared-change.js';

const anIntent = (id: string): Intent => ({
  id,
  statement: 'clicking Send check-in makes the badge read "checked in"',
  state: IntentState.DECLARED,
  declaredAt: 1,
});

const none = (): Promise<readonly Intent[]> => Promise.resolve([]);
const one = (): Promise<readonly Intent[]> => Promise.resolve([anIntent('checkin')]);

describe('isChangeUndeclared', () => {
  it('fires on the first verdict drawn after a code change nobody declared', async () => {
    expect(await isChangeUndeclared(1, none)).toBe(true);
  });

  /**
   * The gap is a statement about THIS verdict, not about the edit. Every verdict drawn while the
   * change is undeclared is a verdict checked against nothing but itself, so every one of them is
   * weaker for the absence — exactly as an unwatched store weakens every state assertion made over
   * it, not merely the first.
   */
  it('fires on the second and third verdict after an undeclared edit, not only the first', async () => {
    expect(await isChangeUndeclared(3, none)).toBe(true);
    expect(await isChangeUndeclared(3, none)).toBe(true);
    expect(await isChangeUndeclared(3, none)).toBe(true);
  });

  /**
   * The agent has said what the change was for. Silence is the correct response to a declaration —
   * anything else is a nag, and a nag is how an agent learns to stop reading findings.
   */
  it('is silent when the ledger holds an undischarged intent', async () => {
    expect(await isChangeUndeclared(3, one)).toBe(false);
  });

  /** The one move that closes this, and it closes it from the very next verdict. */
  it('goes quiet from the next verdict on once an intent is declared mid-run', async () => {
    expect(await isChangeUndeclared(3, none)).toBe(true);
    expect(await isChangeUndeclared(3, one)).toBe(false);
    expect(await isChangeUndeclared(3, one)).toBe(false);
  });

  /**
   * ABSENCE OF EVIDENCE, NOT EVIDENCE OF ABSENCE. Outside Vite there is no channel that could report
   * an edit at all, so the epoch means "no edits OBSERVED" — never "no edits happened". A finding
   * built on an absence Reticle cannot see is a fabrication.
   */
  it('is silent when no edit epoch was ever observed', async () => {
    expect(await isChangeUndeclared(undefined, none)).toBe(false);
  });

  /** The page has a hot-update channel and it has never fired. Nothing changed, so nothing is due. */
  it('is silent for as long as the epoch has not moved off its no-edits start', async () => {
    expect(await isChangeUndeclared(NO_EDITS_OBSERVED, none)).toBe(false);
    expect(await isChangeUndeclared(NO_EDITS_OBSERVED, none)).toBe(false);
  });

  it('does not read the ledger at all when no edit was observed', async () => {
    let reads = 0;
    const counted = (): Promise<readonly Intent[]> => {
      reads += 1;
      return Promise.resolve([]);
    };
    await isChangeUndeclared(NO_EDITS_OBSERVED, counted);
    await isChangeUndeclared(undefined, counted);
    expect(reads).toBe(0);
  });
});
