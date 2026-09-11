/**
 * The agent's feedback call stopped waiting for the network. This is what keeps that honest.
 *
 * The awaited version existed because `sent` had been unconditional: a DNS miss and a 4xx both
 * reported "filed", on the only qualitative channel the product has. Removing the wait without
 * this would restore that exactly — a report announced as filed and silently lost.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  noteFeedbackUndelivered,
  takeFeedbackUndelivered,
  resetFeedbackDelivery,
} from './feedback-delivery.js';

describe('feedback delivery notice', () => {
  beforeEach(() => {
    resetFeedbackDelivery();
  });

  it('has nothing to say when every report landed', () => {
    expect(takeFeedbackUndelivered()).toBeUndefined();
  });

  it('carries a failed send to the reporter', () => {
    noteFeedbackUndelivered('the telemetry endpoint refused it (503)');
    expect(takeFeedbackUndelivered()).toContain('503');
  });

  /**
   * Once. A reporter who cannot fix the network does not need it on every subsequent call, and a
   * banner that repeats is one an agent learns to skip — which is how the NEXT real notice is missed.
   */
  it('says it once, not on every later tool result', () => {
    noteFeedbackUndelivered('offline');
    expect(takeFeedbackUndelivered()).toBe('offline');
    expect(takeFeedbackUndelivered()).toBeUndefined();
  });
});
