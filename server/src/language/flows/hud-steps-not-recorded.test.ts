import { describe, expect, it } from 'vitest';
import { RecordingStore, AMBIENT_RECORDING } from './recording/tape/recordings.js';
import { captureAct, compileSequenceStep } from './replay.js';
import { describeStepResult } from '@/surface/tools/act/act-sequence-retry.js';

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

  // Night 7a filtered single acts only: a HUD click inside one multi-step reticle_act still joined.
  it('is not recorded when it is one step of a multi-step act', () => {
    const steps = [
      { ref: 'e1', action: 'click' },
      { ref: 'e9', action: 'click' },
      { ref: 'e2', action: 'click' },
    ];
    const results = [
      describeStepResult(steps[0] ?? {}, { testid: 'login-submit' }),
      describeStepResult(steps[1] ?? {}, { name: 'Agent log', reticleUi: true }),
      describeStepResult(steps[2] ?? {}, { testid: 'nav-deployments' }),
    ];
    const recorded = compileSequenceStep({ steps }, { count: 3, steps: results });
    const kept = recorded.args['steps'] as Record<string, unknown>[];
    expect(kept.map((step) => step['value'])).toEqual(['login-submit', 'nav-deployments']);
  });
});
