import { describe, expect, it } from 'vitest';
import { currentDrivenBy, runDrivenBy } from './driven-by.js';

/*
 * A drive runs in the background while the agent keeps calling tools. A module-wide flag raised
 * for the drive's span credited the agent's own verdicts, made meanwhile, to the Harness.
 */
describe('which drive a call belongs to', () => {
  it('is the drive inside it, and nobody outside it while the drive is still running', async () => {
    const by = { harness: 'h1', driver: 'server' };
    let release = (): void => undefined;
    let inside: unknown;
    const drive = runDrivenBy(
      by,
      () =>
        new Promise<void>((resolve) => {
          inside = currentDrivenBy();
          release = resolve;
        }),
    );
    expect(inside).toEqual(by);
    expect(currentDrivenBy()).toBeUndefined();
    release();
    await drive;
  });
});
