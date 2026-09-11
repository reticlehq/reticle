import { describe, expect, it } from 'vitest';
import { anchorsOf, recordingReachedAnchor } from './recording-reached-anchor.mjs';

const step = (value) => ({
  tool: 'reticle_act',
  anchor: { kind: 'testid', value },
  action: 'click',
});

describe('recordingReachedAnchor', () => {
  it('passes when the recording drove the anchor the cell will break', () => {
    const flow = { steps: [step('login-submit'), step('nav-diagnostics'), step('fault-500')] };
    expect(recordingReachedAnchor('d-verify-500', 'fault-500', flow).ok).toBe(true);
  });

  // The real shape of the failure: three login steps and nothing else, saved as a healthy flow.
  it('fails a recording that truncated before reaching the anchor', () => {
    const flow = {
      steps: [step('login-email'), step('login-password'), step('login-submit')],
    };
    const v = recordingReachedAnchor('d-verify-500', 'fault-500', flow);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('never touched "fault-500"');
    expect(v.reason).toContain('login-email > login-password > login-submit');
  });

  it('fails an empty recording rather than reading it as reaching nothing in particular', () => {
    const v = recordingReachedAnchor('d-verify-route', 'nav-compose', { steps: [] });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('(none)');
  });

  it('reads the older `target` step shape too', () => {
    const flow = { steps: [{ target: { value: 'fault-500' } }] };
    expect(anchorsOf(flow)).toEqual(['fault-500']);
  });
});
