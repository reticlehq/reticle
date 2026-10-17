import { describe, expect, it } from 'vitest';
import { RecordingStore, AMBIENT_RECORDING } from './recording/tape/recordings.js';
import { captureAct } from './replay.js';

/**
 * Matrix drive, bench-app with the HUD exposed: the flow auto-saved for "signing in … at phone
 * width" carried "Reticle Harness", "Run Harness" and "Agent log" clicks, which belonged to another
 * intent and to Reticle's own panel, not the app. Replayed, it pressed Run Harness: a paid drive.
 * A click on Reticle's own UI is never a step of the app's journey.
 */
describe("a click on Reticle's own UI", () => {
  it('is not recorded into the flow of the app', () => {
    const store = new RecordingStore();
    captureAct(
      store,
      { ref: 'e1', action: 'click', until: { kind: 'route', pathname: '/deployments' } },
      { ok: true, testid: 'login-submit' },
    );
    captureAct(store, { ref: 'e9', action: 'click' }, { ok: true, reticleUi: true });
    expect(store.stepCount(AMBIENT_RECORDING)).toBe(1);
  });
});
