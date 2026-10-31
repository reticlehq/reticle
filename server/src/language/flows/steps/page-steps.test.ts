/**
 * The sender behind a flow's `request` step. It goes only to the app's own origin, with the page's
 * cookies for that host and no others, or with none when the step is anonymous. When it cannot read
 * the cookies it says so and sends nothing: a request meant to run as the signed-in user that went
 * out signed out would test a different rule.
 */
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requestSender } from './page-steps.js';
import type { RealInputProvider } from '@/portal/input/real-input.js';

let origin = '';
const seen: { method: string | undefined; url: string | undefined; cookie: string | undefined }[] =
  [];
const server = createServer((req: IncomingMessage, res) => {
  seen.push({ method: req.method, url: req.url, cookie: req.headers.cookie });
  res.writeHead('/moved' === req.url ? 302 : 400, { location: '/elsewhere' });
  res.end('{"error":"Invalid sort."}');
});

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(() => {
  server.close();
});

const provider = {
  storageState: () =>
    Promise.resolve({
      cookies: [
        { name: 'token', value: 'abc', domain: '127.0.0.1' },
        { name: 'other', value: 'x', domain: 'example.com' },
      ],
    }),
} as unknown as RealInputProvider;

describe('the request sender', () => {
  it('sends the page cookies for the app host only, and returns the answer', async () => {
    const send = requestSender(() => `${origin}/`, provider);
    const answer = await send({ method: 'GET', url: '/api/links?sort=bogus' });
    expect(answer).toEqual({ status: 400, body: '{"error":"Invalid sort."}' });
    expect(seen.at(-1)).toEqual({
      method: 'GET',
      url: '/api/links?sort=bogus',
      cookie: 'token=abc',
    });
  });

  it('sends no cookie for an anonymous step', async () => {
    const send = requestSender(() => `${origin}/`, provider);
    await send({ method: 'GET', url: '/api/links', anonymous: true });
    expect(seen.at(-1)?.cookie).toBeUndefined();
  });

  it('does not follow a redirect: the redirect is the answer', async () => {
    const send = requestSender(() => `${origin}/`, provider);
    const answer = await send({ method: 'GET', url: '/moved', anonymous: true });
    expect('status' in answer ? answer.status : answer.error).toBe(302);
  });

  it('refuses a URL on another origin and sends nothing', async () => {
    const before = seen.length;
    const send = requestSender(() => `${origin}/`, provider);
    const answer = await send({ method: 'GET', url: 'http://example.com/steal' });
    expect('error' in answer).toBe(true);
    expect(seen.length).toBe(before);
  });

  it('sends nothing as the user when the cookies cannot be read', async () => {
    const before = seen.length;
    const send = requestSender(() => `${origin}/`, undefined);
    const answer = await send({ method: 'GET', url: '/api/links' });
    expect('error' in answer).toBe(true);
    expect(seen.length).toBe(before);
  });
});

/*
 * A rule about who may change what can only be checked as someone else: a check that acts as the
 * owner cannot tell "only the owner may pause this link" from "anyone may". `as` names another
 * account, and its session comes from a secret supplied at replay, never from the flow file.
 */
describe('the request sender, as another account', () => {
  it("sends that account's session instead of the page's cookies", async () => {
    const send = requestSender(
      () => `${origin}/`,
      provider,
      (name) => ('SECOND_USER' === name ? 'token=other' : undefined),
    );
    await send({ method: 'GET', url: '/api/links', as: 'SECOND_USER' });
    expect(seen.at(-1)?.cookie).toBe('token=other');
  });

  it('sends nothing when that session was not supplied', async () => {
    const before = seen.length;
    const send = requestSender(
      () => `${origin}/`,
      provider,
      () => undefined,
    );
    const answer = await send({ method: 'GET', url: '/api/links', as: 'SECOND_USER' });
    expect('error' in answer ? answer.error : '').toContain('SECOND_USER');
    expect(seen.length).toBe(before);
  });
});
