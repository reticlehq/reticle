/**
 * The session facts a verdict is allowed to rest on.
 *
 * The rule worth pinning is the empty-string one: the bridge sets `versionSkew` only on a real
 * mismatch, but a defaulted or cleared field reaching `decideVerified` would turn every call into
 * `unknown` — costing every green a page had honestly earned. That is a worse failure than the one
 * the skew clause exists to fix, so absence and emptiness both mean "no skew".
 */

import { describe, expect, it } from 'vitest';
import { sessionVerdictFacts } from './session-verdict-facts.js';

describe('the facts a session contributes to a verdict', () => {
  it('omits everything when the session declared nothing', () => {
    expect(sessionVerdictFacts({})).toEqual({});
  });

  it('carries a real skew', () => {
    expect(sessionVerdictFacts({ versionSkew: 'page 2.14.0 / daemon 3.2.0' })).toEqual({
      versionSkew: 'page 2.14.0 / daemon 3.2.0',
    });
  });

  it('treats an empty skew as no skew, so a cleared field cannot cost a verdict', () => {
    expect(sessionVerdictFacts({ versionSkew: '' })).toEqual({});
  });

  it('carries the sdk version for the unread-body remedy', () => {
    expect(sessionVerdictFacts({ sdkVersion: '3.2.0' })).toEqual({ sdkVersion: '3.2.0' });
  });

  it('carries both when both are present', () => {
    expect(sessionVerdictFacts({ sdkVersion: '3.2.0', versionSkew: 'a / b' })).toEqual({
      sdkVersion: '3.2.0',
      versionSkew: 'a / b',
    });
  });
});
