import { describe, expect, it } from 'vitest';
import { EventType, PredicateKind, ResponseBodyReason, type ReticleEvent } from '@reticlehq/core';
import { evalNet } from '../question/predicate/predicate-eval.js';
import { mergeNetworkDetail } from './network-detail-merge.js';

function request(id: string, extra: Record<string, unknown> = {}): ReticleEvent {
  return {
    type: EventType.NET_REQUEST,
    sessionId: 'sse-test',
    t: 1,
    data: {
      id,
      method: 'POST',
      url: '/api/chat',
      status: 200,
      responseBodyReason: ResponseBodyReason.UNREADABLE,
      ...extra,
    },
  };
}

function detail(id: string, body: string, extra: Record<string, unknown> = {}): ReticleEvent {
  return {
    type: EventType.NET_RESPONSE_BODY,
    sessionId: 'sse-test',
    t: 2,
    data: {
      id,
      method: 'POST',
      url: '/api/chat',
      responseBody: body,
      ...extra,
    },
  };
}

describe('SSE bodies enrich the completed request without duplicating it (#1848)', () => {
  it('removes the unavailable reason and stale truncation after a complete capture', () => {
    const merged = mergeNetworkDetail([
      request('n1', { responseBodyTruncated: true }),
      detail('n1', 'data: hello\n\n'),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.data['responseBody']).toBe('data: hello\n\n');
    expect(merged[0]?.data['responseBodyReason']).toBeUndefined();
    expect(merged[0]?.data['responseBodyTruncated']).toBeUndefined();
  });

  it('merges a wire detail carrying a response body without requiring an SDK id', () => {
    const headers = { 'content-type': 'text/event-stream' };
    const merged = mergeNetworkDetail([
      request('n1'),
      {
        type: EventType.NET_DETAIL,
        sessionId: 'sse-test',
        t: 2,
        data: {
          method: 'POST',
          url: '/api/chat',
          status: 200,
          headers,
          responseBody: 'data: wire\n\n',
        },
      },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.data['headers']).toEqual(headers);
  });

  it('does not fall back to the URL when an SDK detail has no matching id', () => {
    const merged = mergeNetworkDetail([
      request('n1'),
      detail('missing', 'data: other\n\n', { headers: { etag: 'other' } }),
    ]);
    expect(merged).toHaveLength(2);
    expect(
      merged.find((event) => EventType.NET_REQUEST === event.type)?.data['headers'],
    ).toBeUndefined();
  });

  it('correlates overlapping streams by id, not only their shared URL', () => {
    const merged = mergeNetworkDetail([
      request('n1'),
      request('n2'),
      detail('n2', 'data: second\n\n'),
      detail('n1', 'data: first\n\n'),
    ]);
    expect(merged).toHaveLength(2);
    expect(merged.find((event) => 'n1' === event.data['id'])?.data['responseBody']).toBe(
      'data: first\n\n',
    );
    expect(merged.find((event) => 'n2' === event.data['id'])?.data['responseBody']).toBe(
      'data: second\n\n',
    );
  });

  it.each([
    { id: 'other', fields: {} },
    { id: 'n1', fields: { url: '/api/other' } },
    { id: 'n1', fields: { method: 'GET' } },
  ])(
    'does not attach response data from an unmatched observation: $id $fields',
    ({ id, fields }) => {
      const merged = mergeNetworkDetail([request('n1'), detail(id, 'data: other\n\n', fields)]);
      expect(
        merged.find((event) => EventType.NET_REQUEST === event.type)?.data['responseBody'],
      ).toBeUndefined();
    },
  );

  it.each([false, true])('judges a body detail with truncated=$truncated', (truncated) => {
    const events = [
      request('n1'),
      detail('n1', 'data: hello\n\n', truncated ? { responseBodyTruncated: true } : {}),
    ];
    expect(
      evalNet(events, { kind: 'net', urlContains: '/api/chat', bodyContains: 'hello', count: 1 })
        .pass,
    ).toBe(true);
    const missed = evalNet(events, {
      kind: 'net',
      urlContains: '/api/chat',
      bodyContains: 'goodbye',
    });
    expect(missed.pass).toBe(false);
    expect(missed.inconclusive !== undefined).toBe(truncated);
    if (truncated) {
      expect(missed.failureReason).toBeUndefined();
    } else {
      expect(missed.failureReason).toBeDefined();
    }
  });
});

/*
 * A file the server sends as a download (`Content-Disposition: attachment`) leaves the page as a
 * navigation, not a fetch, so the in-page observer never records it. The driven browser does see the
 * response. Before, that detail survived as a NET_DETAIL that no `net` check reads, and a check on a
 * working CSV export answered "no network call matched".
 */
describe('a download the driven browser saw, with no in-page request', () => {
  function wire(headers: Record<string, string>): ReticleEvent {
    return {
      type: EventType.NET_DETAIL,
      sessionId: 's',
      t: 5,
      data: { method: 'GET', url: '/api/links/export?search=u0', status: 200, headers },
    };
  }

  it('becomes an observed request that a net check can match', () => {
    const merged = mergeNetworkDetail([
      wire({
        'content-type': 'text/csv',
        'content-disposition': 'attachment; filename="links.csv"',
      }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.type).toBe(EventType.NET_REQUEST);
    expect(merged[0]?.data['status']).toBe(200);
    const verdict = evalNet(merged, {
      kind: PredicateKind.NET,
      method: 'GET',
      urlContains: '/api/links/export',
      status: 200,
    });
    expect(verdict.pass).toBe(true);
  });

  it('carries the download initiator, so a reader can tell the page never saw it', () => {
    const merged = mergeNetworkDetail([wire({ 'content-disposition': 'attachment' })]);
    expect(merged[0]?.data['initiator']).toBe('download');
  });

  it('leaves any other unmatched detail as a detail', () => {
    const merged = mergeNetworkDetail([wire({ 'content-type': 'text/html' })]);
    expect(merged[0]?.type).toBe(EventType.NET_DETAIL);
  });

  it('does not add a second request when the page did record the call', () => {
    const page: ReticleEvent = {
      type: EventType.NET_REQUEST,
      sessionId: 's',
      t: 4,
      data: { method: 'GET', url: '/api/links/export?search=u0', status: 200 },
    };
    const merged = mergeNetworkDetail([page, wire({ 'content-disposition': 'attachment' })]);
    expect(merged.filter((e) => e.type === EventType.NET_REQUEST)).toHaveLength(1);
  });
});

/*
 * The download had to be visible to a plain `net` check too. evalNet merged details only for a
 * body clause, so `{ method, urlContains, status }` on a working export still read "no call matched".
 */
describe('a net check with no body clause, over a server-sent download', () => {
  it('matches the download', () => {
    const events: ReticleEvent[] = [
      {
        type: EventType.NET_DETAIL,
        sessionId: 's',
        t: 5,
        data: {
          method: 'GET',
          url: '/api/links/export',
          status: 200,
          headers: { 'content-disposition': 'attachment; filename="links.csv"' },
        },
      },
    ];
    const verdict = evalNet(events, {
      kind: PredicateKind.NET,
      method: 'GET',
      urlContains: '/api/links/export',
      status: 200,
    });
    expect(verdict.pass).toBe(true);
  });
});
