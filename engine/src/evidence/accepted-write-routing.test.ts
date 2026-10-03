import { describe, expect, it } from 'vitest';
import {
  ConsequenceKind,
  EventType,
  HTTP_ACCEPTED,
  URL_RAW,
  type ExpectedLink,
  type ReticleEvent,
} from '@reticlehq/core';
import { acceptedWriteLabels } from './accepted-write.js';

/**
 * Which 202s decide a verdict (#1120).
 *
 * `outcome_pending` is right for the write the claim is about, and wrong for everything else that
 * answered 202 in the same window: an analytics beacon made every verdict `unknown`, and a claim
 * that deliberately asserted "the POST returned 202 and accepted: true" could not say so. The
 * filter lives at the evidence boundary, so both callers inherit it.
 */
const APP = 'https://app.example.test';

const request = (method: string, url: string, status: number): ReticleEvent =>
  ({
    type: EventType.NET_REQUEST,
    t: 1,
    data: { method, url, status },
  }) as unknown as ReticleEvent;

const link = (urlContains: string, status?: number, method?: string): ExpectedLink => ({
  kind: ConsequenceKind.NET,
  urlContains,
  ...(status === undefined ? {} : { status }),
  ...(method === undefined ? {} : { method }),
});

describe('a 202 that is not the outcome of the claim', () => {
  it('ignores third-party traffic', () => {
    expect(
      acceptedWriteLabels(
        [request('POST', 'https://analytics.other.test/collect', HTTP_ACCEPTED)],
        {
          appUrl: APP,
        },
      ),
    ).toEqual([]);
  });

  it('ignores an endpoint the project declared as background', () => {
    expect(
      acceptedWriteLabels([request('POST', '/api/log', HTTP_ACCEPTED)], {
        appUrl: APP,
        background: ['/api/log'],
      }),
    ).toEqual([]);
  });

  it('ignores a read, which has no outcome to reconcile', () => {
    expect(
      acceptedWriteLabels([request('GET', '/api/status', HTTP_ACCEPTED)], { appUrl: APP }),
    ).toEqual([]);
  });

  it("keeps the app's own mutation pending — the optimistic-UI case", () => {
    expect(
      acceptedWriteLabels([request('POST', '/api/dispatch', HTTP_ACCEPTED)], { appUrl: APP }),
    ).toEqual(['POST /api/dispatch']);
  });
});

describe('a 202 the claim itself asserted on', () => {
  it('is not pending when the proven link names it with status 202', () => {
    expect(
      acceptedWriteLabels([request('POST', '/api/save', HTTP_ACCEPTED)], {
        appUrl: APP,
        asserted: [link('/api/save', HTTP_ACCEPTED)],
      }),
    ).toEqual([]);
  });

  it('stays pending when the claim only asserted the request happened', () => {
    // A net clause with no status says the call occurred, not that its acceptance was the point.
    expect(
      acceptedWriteLabels([request('POST', '/api/save', HTTP_ACCEPTED)], {
        appUrl: APP,
        asserted: [link('/api/save')],
      }),
    ).toEqual(['POST /api/save']);
  });

  it('a link for a 200 branch does not exempt the 202 that also fired', () => {
    // `anyOf([net /save 200, net /save 202])`: when the 200 branch is the one that held, the proven
    // link carries 200, and the 202 still means the server has not finished.
    expect(
      acceptedWriteLabels([request('POST', '/api/save', HTTP_ACCEPTED)], {
        appUrl: APP,
        asserted: [link('/api/save', 200)],
      }),
    ).toEqual(['POST /api/save']);
  });

  it('an anyOf whose 200 branch ALSO held does not exempt the 202', () => {
    // Both branches currently pass (a 200 and a 202 on the endpoint), so the proof carries both
    // links. The verdict could have been green without the acceptance, and the accepted write's
    // outcome is still owed — only a request whose every proven link says 202 is the claim's own.
    expect(
      acceptedWriteLabels([request('POST', '/api/save', HTTP_ACCEPTED)], {
        appUrl: APP,
        asserted: [link('/api/save', 200), link('/api/save', HTTP_ACCEPTED)],
      }),
    ).toEqual(['POST /api/save']);
  });

  it('a link that names a different method does not exempt the write', () => {
    // `net` distinguishes methods, and the links must too: a claim about `GET /save` does not
    // settle the `POST /save` that is still pending.
    expect(
      acceptedWriteLabels([request('POST', '/api/save', HTTP_ACCEPTED)], {
        appUrl: APP,
        asserted: [link('/api/save', HTTP_ACCEPTED, 'GET')],
      }),
    ).toEqual(['POST /api/save']);
  });

  it('a link with the matching method still exempts it', () => {
    expect(
      acceptedWriteLabels([request('POST', '/api/save', HTTP_ACCEPTED)], {
        appUrl: APP,
        asserted: [link('/api/save', HTTP_ACCEPTED, 'POST')],
      }),
    ).toEqual([]);
  });

  it('matches a URL the way the predicate did, raw when redaction rewrote it', () => {
    const redacted = {
      type: EventType.NET_REQUEST,
      t: 1,
      data: {
        method: 'POST',
        url: '/verify/[REDACTED]',
        [URL_RAW]: '/verify/CERT_INFY_10',
        status: HTTP_ACCEPTED,
      },
    } as unknown as ReticleEvent;
    expect(
      acceptedWriteLabels([redacted], {
        appUrl: APP,
        asserted: [link('/verify/CERT_INFY_10', HTTP_ACCEPTED)],
      }),
    ).toEqual([]);
  });
});
