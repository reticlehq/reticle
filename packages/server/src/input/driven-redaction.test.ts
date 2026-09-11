import { afterEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { MessageKind, RETICLE_PROTOCOL_VERSION, type HelloMessage } from '@reticlehq/core';
import {
  declareDrivenRedactionKeys,
  drivenRedactionKeys,
  drivenRedactionPolicy,
  forgetDrivenRedactionKeys,
  resetDrivenRedaction,
} from './driven-redaction.js';
import { buildNetworkDetail } from './network-detail.js';
import { Session } from '../session/session.js';
import { SessionManager } from '../session/session-manager.js';

afterEach(() => {
  resetDrivenRedaction();
});

describe('an app-declared key reaches the driven path', () => {
  it('redacts a declared key in a captured request body that never touched the SDK', () => {
    // The leak this exists to close: `page.on('response')` hands the daemon a raw body, which goes
    // to the agent and the on-disk journal. Without the declaration crossing the bridge, the app's
    // own credential is redacted everywhere the developer looks and cleartext where they cannot.
    const raw = { url: 'http://x/api', status: 200, headers: {} };
    const body = JSON.stringify({ licenceKey: 'LK-9', note: 'fine' });

    const before = buildNetworkDetail({ ...raw, requestBody: body }, drivenRedactionPolicy());
    expect(before.requestBody).toContain('LK-9');

    declareDrivenRedactionKeys('s1', ['licenceKey']);
    const after = buildNetworkDetail({ ...raw, requestBody: body }, drivenRedactionPolicy());
    expect(after.requestBody).not.toContain('LK-9');
    expect(after.requestBody).toContain('[REDACTED]');
    expect(after.requestBody).toContain('fine'); // still additive: nothing else changed
  });

  it('redacts a declared key in a form-encoded body, not only in JSON', () => {
    declareDrivenRedactionKeys('s1', ['partnerCode']);
    const detail = buildNetworkDetail(
      {
        url: 'http://x/api',
        status: 200,
        headers: {},
        requestBody: 'partnerCode=ACME-7&keep=yes',
      },
      drivenRedactionPolicy(),
    );
    expect(detail.requestBody).not.toContain('ACME-7');
    expect(detail.requestBody).toContain('keep=yes');
  });

  it('redacts a declared HEADER name', () => {
    declareDrivenRedactionKeys('s1', ['x-tenant-licence']);
    const detail = buildNetworkDetail(
      { url: 'http://x', status: 200, headers: { 'X-Tenant-Licence': 'LK-9' } },
      drivenRedactionPolicy(),
    );
    expect(detail.headers['x-tenant-licence']).toBe('[REDACTED]');
  });
});

describe('the default floor is unchanged when nothing is declared', () => {
  it('builds an identical detail with no declarations, policy or not', () => {
    const raw = {
      url: 'http://x/api',
      status: 200,
      headers: { authorization: 'Bearer abc', 'content-type': 'application/json' },
      requestBody: JSON.stringify({ password: 'hunter2', amount: 12 }),
    };
    expect(buildNetworkDetail(raw, drivenRedactionPolicy())).toEqual(buildNetworkDetail(raw));
  });

  it('keeps redacting the built-in credentials once a declaration exists', () => {
    declareDrivenRedactionKeys('s1', ['licenceKey']);
    const detail = buildNetworkDetail(
      {
        url: 'http://x/api',
        status: 200,
        headers: { authorization: 'Bearer abc' },
        requestBody: JSON.stringify({ password: 'hunter2' }),
      },
      drivenRedactionPolicy(),
    );
    expect(detail.headers['authorization']).toBe('[REDACTED]');
    expect(detail.requestBody).not.toContain('hunter2');
  });
});

describe('the union tracks session lifetime', () => {
  it('unions the declarations of every connected session', () => {
    declareDrivenRedactionKeys('s1', ['alpha']);
    declareDrivenRedactionKeys('s2', ['beta', 'alpha']);
    expect(drivenRedactionKeys()).toEqual(['alpha', 'beta']);
  });

  it('narrows again when a session disconnects, so a closed tab stops widening it', () => {
    declareDrivenRedactionKeys('s1', ['alpha']);
    declareDrivenRedactionKeys('s2', ['beta']);
    forgetDrivenRedactionKeys('s1');
    expect(drivenRedactionKeys()).toEqual(['beta']);
    expect(drivenRedactionPolicy().isSensitiveKey('alpha')).toBe(false);
    expect(drivenRedactionPolicy().isSensitiveKey('beta')).toBe(true);
  });

  it("a re-declaration replaces that session's keys rather than accumulating them", () => {
    declareDrivenRedactionKeys('s1', ['alpha']);
    declareDrivenRedactionKeys('s1', ['beta']);
    expect(drivenRedactionKeys()).toEqual(['beta']);
  });

  it('declaring nothing removes any earlier declaration for that session', () => {
    declareDrivenRedactionKeys('s1', ['alpha']);
    declareDrivenRedactionKeys('s1', []);
    expect(drivenRedactionKeys()).toEqual([]);
  });

  it('re-uses the policy object while the key set is unchanged, so the hot path does not rebuild', () => {
    declareDrivenRedactionKeys('s1', ['alpha']);
    expect(drivenRedactionPolicy()).toBe(drivenRedactionPolicy());
    declareDrivenRedactionKeys('s2', ['beta']);
    expect(drivenRedactionPolicy().isSensitiveKey('beta')).toBe(true);
  });
});

describe('the session lifecycle drives the union', () => {
  const hello = (sessionId: string, redactKeys?: string[]): HelloMessage => ({
    kind: MessageKind.HELLO,
    protocolVersion: RETICLE_PROTOCOL_VERSION,
    sessionId,
    url: 'http://localhost/',
    title: 'App',
    adapters: [],
    hasCapabilities: false,
    ...(redactKeys === undefined ? {} : { redactKeys }),
  });
  const fakeSocket = { send: (): void => {} } as unknown as WebSocket;
  const makeSession = (id: string, keys?: string[]): Session =>
    new Session(hello(id, keys), fakeSocket, () => 0);

  it('a connecting app widens the driven rule, and its disconnect narrows it back', () => {
    const manager = new SessionManager();
    const session = makeSession('s1', ['licenceKey']);

    manager.add(session);
    expect(drivenRedactionPolicy().isSensitiveKey('licenceKey')).toBe(true);

    manager.remove(session);
    expect(drivenRedactionPolicy().isSensitiveKey('licenceKey')).toBe(false);
  });

  it('an SDK that sends no redactKeys leaves the rule exactly as it was', () => {
    const manager = new SessionManager();
    manager.add(makeSession('legacy'));
    expect(drivenRedactionKeys()).toEqual([]);
  });
});
