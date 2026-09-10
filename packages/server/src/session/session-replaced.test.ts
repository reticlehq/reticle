/**
 * A reconnect is not a fault, and recognising it must not depend on two files agreeing by hand.
 */

import { describe, expect, it } from 'vitest';
import {
  SESSION_REPLACED_PREFIX,
  isSessionReplacedError,
  sessionReplacedReason,
} from './session-replaced.js';

describe('recognising a session that was replaced by a reconnect', () => {
  it('recognises the reason the bridge actually produces', () => {
    // The point of the shared builder: the predicate is tested against the PRODUCER's output, not
    // against a copy of it that could drift.
    expect(isSessionReplacedError(new Error(sessionReplacedReason('s1', 'http://app/page')))).toBe(
      true,
    );
  });

  it('recognises it from a bare string as well as an Error', () => {
    expect(isSessionReplacedError(sessionReplacedReason('s1', 'http://app/'))).toBe(true);
  });

  it('does not fire on an unrelated failure', () => {
    expect(isSessionReplacedError(new Error('element is disabled'))).toBe(false);
    expect(isSessionReplacedError(new Error('command timed out after 8000ms'))).toBe(false);
  });

  it('survives a thrown non-error without throwing itself', () => {
    expect(isSessionReplacedError(undefined)).toBe(false);
    expect(isSessionReplacedError({ nope: true })).toBe(false);
  });

  it('names the id and the url, which is what turns it into a diagnosis', () => {
    const reason = sessionReplacedReason('s-42', 'http://app/checkout');
    expect(reason).toContain('s-42');
    expect(reason).toContain('http://app/checkout');
    expect(reason.startsWith(SESSION_REPLACED_PREFIX)).toBe(true);
  });
});
