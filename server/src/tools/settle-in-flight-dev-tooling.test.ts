/**
 * The dev-tooling exclusion has to hold in the SETTLEMENT wait too, or it is cosmetic.
 *
 * `evalSettled` and `findContradictions` both drop the toolchain's own traffic (see
 * DevToolingChannel) — but the act path's settle wait, and the "still in flight" sentence an
 * unsettled verdict is built from, read the raw window. Reported from a real drive: a deliberately
 * disabled control, with zero application requests, was graded on the strength of a Next webpack
 * hot-update that Reticle itself had already classified as dev tooling and printed as ignored.
 *
 * Over-exclusion is the failure mode in the other direction, so every case here has its app-request
 * twin: a real request in the same position must still hold the window open.
 */

import { describe, expect, it } from 'vitest';
import { EventType } from '@reticlehq/core';
import {
  inFlightRequestIds,
  inFlightRequestLabels,
  repeatedRequestLabels,
} from './settle-in-flight.js';

const HMR = 'http://localhost:3000/_next/static/webpack/633457081244afec.webpack.hot-update.json';
const OVERLAY = 'http://localhost:3000/__nextjs_original-stack-frames';
const APP = 'http://localhost:3000/api/save';

const pending = (id: string, url: string): { type: string; data: Record<string, unknown> } => ({
  type: EventType.NET_PENDING,
  data: { id, method: 'POST', url },
});
const done = (id: string, url: string): { type: string; data: Record<string, unknown> } => ({
  type: EventType.NET_REQUEST,
  data: { id, method: 'POST', url, status: 200 },
});

describe('settlement ignores the traffic the rest of Reticle already ignores', () => {
  it('an in-flight hot-update does not hold the window open', () => {
    expect(inFlightRequestIds([pending('d1', HMR)])).toEqual([]);
  });

  it('the dev overlay is not named as a request that never came back', () => {
    expect(inFlightRequestLabels([pending('d2', OVERLAY)])).toEqual([]);
  });

  it('a polling dev channel is not reported as the app churning', () => {
    expect(repeatedRequestLabels([done('d3', HMR), done('d4', HMR)])).toEqual([]);
  });

  // ── over-exclusion guard ──────────────────────────────────────────────────────────────────────
  it('a REAL request still holds the window open, dev tooling beside it or not', () => {
    expect(inFlightRequestIds([pending('d1', HMR), pending('a1', APP)])).toEqual(['a1']);
    expect(inFlightRequestLabels([pending('d1', HMR), pending('a1', APP)])).toEqual([
      `POST ${APP}`,
    ]);
  });

  it('a REAL endpoint called twice is still reported as repeated', () => {
    expect(repeatedRequestLabels([done('a1', APP), done('a2', APP), done('d1', HMR)])).toEqual([
      `POST ${APP} ×2`,
    ]);
  });
});
