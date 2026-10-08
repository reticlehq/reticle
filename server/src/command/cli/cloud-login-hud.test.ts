/**
 * The panel's Sign in, as the daemon handles it.
 *
 * Incident: the HUD's Sign in copied `reticle login` to the clipboard and stopped there, a dead end
 * for anybody who does not live in a terminal. The daemon now starts the browser approval itself.
 */
import { describe, expect, it } from 'vitest';
import { hudSignIn } from './cloud-login.js';

describe('signing in from the panel', () => {
  /**
   * Somebody who closes the approval tab and presses Sign in again must get the page back: the
   * first flow is still polling, and a click that silently does nothing is the dead end again.
   */
  it('reopens the pending approval page instead of doing nothing on a second press', () => {
    const opened: string[] = [];
    const handler = hudSignIn(
      () => undefined,
      (open) => {
        open('https://app.test/device?code=AB12');
        return new Promise<number>(() => undefined);
      },
      (url) => opened.push(url),
    );
    handler();
    handler();
    expect(opened).toEqual([
      'https://app.test/device?code=AB12',
      'https://app.test/device?code=AB12',
    ]);
  });

  it('starts one browser sign-in however often it is pressed, and repaints when it lands', async () => {
    let starts = 0;
    let finish: (code: number) => void = () => undefined;
    let repaints = 0;
    const handler = hudSignIn(
      () => (repaints += 1),
      () => {
        starts += 1;
        return new Promise<number>((resolve) => (finish = resolve));
      },
      () => undefined,
    );
    handler();
    handler();
    expect(starts).toBe(1);
    finish(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(repaints).toBe(1);
    handler();
    expect(starts).toBe(2);
  });

  it('does not repaint, and does not throw, when the sign-in fails or is denied', async () => {
    let repaints = 0;
    const denied = hudSignIn(
      () => (repaints += 1),
      () => Promise.resolve(1),
      () => undefined,
    );
    const broken = hudSignIn(
      () => (repaints += 1),
      () => Promise.reject(new Error('offline')),
      () => undefined,
    );
    denied();
    broken();
    await new Promise((r) => setTimeout(r, 0));
    expect(repaints).toBe(0);
  });
});
