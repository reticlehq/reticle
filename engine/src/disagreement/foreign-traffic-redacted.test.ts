/**
 * A DECLARED background endpoint whose path was redacted is still somebody else's traffic.
 *
 * `splitForeignTraffic` is the ONE place that decides which events the contradiction rules are even
 * allowed to judge, and it classified on the DISPLAYED url. Redaction runs at emit time and rewrites
 * a sensitive path segment in place (`/verify/refresh-token` -> `/verify/[REDACTED]`), keeping the
 * original only in `urlRaw`; a project's `background` pattern is matched with `String.includes`, so
 * `/verify/refresh-token` never matched what this read. The endpoint stayed among the app's own
 * traffic and every rule below judged it — a vendor beacon or a declared telemetry endpoint coming
 * back as `request-never-settled`, `ui-advanced-request-failed` and the rest, on an app that had
 * done nothing wrong.
 *
 * The settle waiter had the identical defect and was fixed beside it; this is the third path that
 * asks "whose traffic is this", and leaving it on the other field is how the three drift apart.
 *
 * Disclosure deliberately keeps the DISPLAYED spelling: `urlRaw` is the match haystack, not
 * something to project into a transcript.
 */

import { describe, expect, it } from 'vitest';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { splitForeignTraffic } from './contradiction-evidence.js';

const APP = 'http://localhost:4312/deployments';

const pending = (id: string, url: string, urlRaw?: string): ReticleEvent => ({
  t: 1,
  seq: 1,
  type: EventType.NET_PENDING,
  sessionId: 's',
  data: { id, method: 'POST', url, ...(urlRaw === undefined ? {} : { urlRaw }) },
});

const REDACTED_URL = 'http://localhost:4312/verify/[REDACTED]';
const RAW_URL = 'http://localhost:4312/verify/refresh-token';

describe('splitForeignTraffic — a declared endpoint is recognised through redaction', () => {
  it('drops it when the declared pattern only matches the RAW url', () => {
    const { app, ignored } = splitForeignTraffic([pending('t1', REDACTED_URL, RAW_URL)], APP, [
      '/verify/refresh-token',
    ]);
    expect(app).toEqual([]);
    expect(ignored).toEqual([REDACTED_URL]);
  });

  it('never puts the raw url in the disclosure — that field is a haystack, not a transcript', () => {
    const { ignored } = splitForeignTraffic([pending('t1', REDACTED_URL, RAW_URL)], APP, [
      '/verify/refresh-token',
    ]);
    expect(ignored.join(' ')).not.toContain('refresh-token');
  });

  // ── over-exclusion guard ──────────────────────────────────────────────────────────────────────
  it('keeps a redacted endpoint the project did NOT declare, so nothing is suppressed by accident', () => {
    const { app, ignored } = splitForeignTraffic([pending('t1', REDACTED_URL, RAW_URL)], APP, [
      '/api/analytics',
    ]);
    expect(app).toHaveLength(1);
    expect(ignored).toEqual([]);
  });

  it('still drops an ordinary undeclared third-party host', () => {
    const { app } = splitForeignTraffic([pending('w1', 'https://pulse.walletconnect.org/e')], APP);
    expect(app).toEqual([]);
  });
});
