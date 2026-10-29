/**
 * The page CSP on a lease off loopback (#2016).
 *
 * A bypass of page CSP let a lease pass where a real user hits a CSP block: a false green. The lease
 * now keeps the page's policy and adds only the daemon's WebSocket origin to `connect-src`. These
 * tests hold the rewrite to that one change, and hold the lease to saying that it made it.
 */
import { describe, expect, it } from 'vitest';
import { allowDaemonInCsp, allowDaemonInHtml, widenDocumentCsp } from './csp-widen.js';
import type { CspRoute } from './csp-widen.js';

const DAEMON = 'ws://localhost:14466';

describe('allowDaemonInCsp', () => {
  it('appends the daemon origin to connect-src and keeps every other directive', () => {
    const policy = "default-src 'self'; connect-src 'self' https://api.example.com; img-src *";
    expect(allowDaemonInCsp(policy, DAEMON)).toEqual({
      policy: `default-src 'self'; connect-src 'self' https://api.example.com ${DAEMON}; img-src *`,
      changed: true,
    });
  });

  it('adds a connect-src that copies default-src when the policy has only default-src', () => {
    const policy = "default-src 'self' https://cdn.example.com; script-src 'self'";
    expect(allowDaemonInCsp(policy, DAEMON)).toEqual({
      policy: `${policy}; connect-src 'self' https://cdn.example.com ${DAEMON}`,
      changed: true,
    });
  });

  it('leaves a policy with neither connect-src nor default-src alone', () => {
    const policy = "script-src 'self'; frame-ancestors 'none'";
    expect(allowDaemonInCsp(policy, DAEMON)).toEqual({ policy, changed: false });
  });

  it("replaces 'none' with the daemon origin, so the page still reaches nothing else", () => {
    expect(allowDaemonInCsp("connect-src 'none'", DAEMON)).toEqual({
      policy: `connect-src ${DAEMON}`,
      changed: true,
    });
    expect(allowDaemonInCsp("default-src 'none'", DAEMON)).toEqual({
      policy: `default-src 'none'; connect-src ${DAEMON}`,
      changed: true,
    });
  });

  it('widens each policy of a comma-joined header, because every one is enforced', () => {
    const policy = "connect-src 'self', default-src https:, img-src 'self'";
    expect(allowDaemonInCsp(policy, DAEMON)).toEqual({
      policy: `connect-src 'self' ${DAEMON}, default-src https:; connect-src https: ${DAEMON}, img-src 'self'`,
      changed: true,
    });
  });

  it('changes nothing when connect-src already names the daemon origin', () => {
    const policy = `connect-src 'self' ${DAEMON}`;
    expect(allowDaemonInCsp(policy, DAEMON)).toEqual({ policy, changed: false });
  });

  it('reads directive names without regard to case, and only the first of a repeated one', () => {
    expect(allowDaemonInCsp("CONNECT-SRC 'self'; connect-src *", DAEMON)).toEqual({
      policy: `CONNECT-SRC 'self' ${DAEMON}; connect-src *`,
      changed: true,
    });
  });
});

describe('allowDaemonInHtml', () => {
  it('widens a <meta http-equiv="Content-Security-Policy"> and nothing else in the page', () => {
    const html =
      `<head><meta http-equiv="Content-Security-Policy" content="connect-src 'self'">` +
      `<meta name="description" content="connect-src 'self'"></head>`;
    expect(allowDaemonInHtml(html, DAEMON)).toEqual({
      html:
        `<head><meta http-equiv="Content-Security-Policy" content="connect-src 'self' ${DAEMON}">` +
        `<meta name="description" content="connect-src 'self'"></head>`,
      changed: true,
    });
  });

  it('reads an unquoted, lower-case http-equiv and widens each meta policy', () => {
    const html =
      `<meta content="default-src 'self'" http-equiv=content-security-policy>` +
      `<META HTTP-EQUIV='Content-Security-Policy' CONTENT="connect-src https:">`;
    expect(allowDaemonInHtml(html, DAEMON).html).toBe(
      `<meta content="default-src 'self'; connect-src 'self' ${DAEMON}" http-equiv=content-security-policy>` +
        `<META HTTP-EQUIV='Content-Security-Policy' CONTENT="connect-src https: ${DAEMON}">`,
    );
  });

  it('leaves a page with no CSP meta tag, and a Report-Only one, alone', () => {
    const html = `<meta http-equiv="Content-Security-Policy-Report-Only" content="connect-src 'none'">`;
    expect(allowDaemonInHtml(html, DAEMON)).toEqual({ html, changed: false });
  });
});

interface FakeOpts {
  resourceType?: string;
  topFrame?: boolean;
  headers?: Record<string, string>;
  cspHeaders?: string[];
  body?: string;
}

function fakeRoute(opts: FakeOpts): {
  route: CspRoute;
  calls: { fallback: number; fetched: unknown[]; fulfilled: Record<string, unknown>[] };
} {
  const calls = {
    fallback: 0,
    fetched: [] as unknown[],
    fulfilled: [] as Record<string, unknown>[],
  };
  const headers = { 'content-type': 'text/html; charset=utf-8', ...opts.headers };
  const response = {
    headers: () => headers,
    headersArray: () => [
      ...Object.entries(headers).map(([name, value]) => ({ name, value })),
      ...(opts.cspHeaders ?? []).map((value) => ({ name: 'Content-Security-Policy', value })),
    ],
    text: () => Promise.resolve(opts.body ?? '<html></html>'),
  };
  const route: CspRoute = {
    request: () => ({
      resourceType: () => opts.resourceType ?? 'document',
      frame: () => ({ parentFrame: () => (false === opts.topFrame ? {} : null) }),
    }),
    fallback: () => {
      calls.fallback += 1;
      return Promise.resolve();
    },
    fetch: (o) => {
      calls.fetched.push(o);
      return Promise.resolve(response);
    },
    fulfill: (o) => {
      calls.fulfilled.push(o);
      return Promise.resolve();
    },
  };
  return { route, calls };
}

describe('widenDocumentCsp', () => {
  it('lets every request that is not the top document go untouched', async () => {
    const widened: string[] = [];
    for (const opts of [{ resourceType: 'script' }, { topFrame: false }]) {
      const { route, calls } = fakeRoute(opts);
      await widenDocumentCsp(route, DAEMON, () => widened.push('x'));
      expect(calls).toEqual({ fallback: 1, fetched: [], fulfilled: [] });
    }
    expect(widened).toEqual([]);
  });

  it('widens every CSP header of the top document, keeps Report-Only, and says so', async () => {
    const { route, calls } = fakeRoute({
      headers: { 'content-security-policy-report-only': "connect-src 'none'" },
      cspHeaders: ["connect-src 'self'", "default-src 'self'"],
    });
    const widened: string[] = [];

    await widenDocumentCsp(route, DAEMON, () => widened.push('x'));

    // A redirect is answered as a redirect, so the browser follows it and the URL stays true.
    expect(calls.fetched).toEqual([{ maxRedirects: 0 }]);
    expect(calls.fulfilled).toHaveLength(1);
    expect(calls.fulfilled[0]?.['headers']).toMatchObject({
      'content-security-policy': `connect-src 'self' ${DAEMON}, default-src 'self'; connect-src 'self' ${DAEMON}`,
      'content-security-policy-report-only': "connect-src 'none'",
    });
    expect(calls.fulfilled[0]?.['body']).toBeUndefined();
    expect(widened).toEqual(['x']);
  });

  it('rewrites a CSP meta tag in the body, and drops the encoding of the old body', async () => {
    const { route, calls } = fakeRoute({
      headers: { 'content-encoding': 'gzip', 'content-length': '10' },
      body: `<meta http-equiv="Content-Security-Policy" content="connect-src 'self'">`,
    });
    const widened: string[] = [];

    await widenDocumentCsp(route, DAEMON, () => widened.push('x'));

    const fulfilled = calls.fulfilled[0] ?? {};
    expect(fulfilled['body']).toBe(
      `<meta http-equiv="Content-Security-Policy" content="connect-src 'self' ${DAEMON}">`,
    );
    expect(fulfilled['headers']).not.toHaveProperty('content-encoding');
    expect(fulfilled['headers']).not.toHaveProperty('content-length');
    expect(widened).toEqual(['x']);
  });

  it('hands back the response unchanged, and says nothing, when the page has no CSP', async () => {
    const { route, calls } = fakeRoute({});
    const widened: string[] = [];

    await widenDocumentCsp(route, DAEMON, () => widened.push('x'));

    expect(calls.fulfilled).toHaveLength(1);
    expect(calls.fulfilled[0]?.['headers']).toBeUndefined();
    expect(calls.fulfilled[0]?.['body']).toBeUndefined();
    expect(widened).toEqual([]);
  });

  it('lets the request go to the network when the fetch fails', async () => {
    const { route, calls } = fakeRoute({});
    route.fetch = () => Promise.reject(new Error('net::ERR_NAME_NOT_RESOLVED'));

    await widenDocumentCsp(route, DAEMON, () => undefined);

    expect(calls).toEqual({ fallback: 1, fetched: [], fulfilled: [] });
  });
});
