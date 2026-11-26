import { describe, expect, it } from 'vitest';
import { MessageKind, RETICLE_PROTOCOL_VERSION } from '@/index.js';
import { HelloMessageSchema } from './messages.js';
import { HelloEnv, HelloScope } from './production/hello-mode.js';

const base = {
  kind: MessageKind.HELLO,
  protocolVersion: RETICLE_PROTOCOL_VERSION,
  sessionId: 'tab-1',
  url: 'https://app.example.com/',
  title: 'App',
  adapters: [],
};

describe('env and scope on a HELLO', () => {
  it('leaves an older HELLO without them valid', () => {
    expect(HelloMessageSchema.safeParse(base).success).toBe(true);
  });

  it('carries a production env and a scope', () => {
    const parsed = HelloMessageSchema.parse({
      ...base,
      env: HelloEnv.PRODUCTION,
      scope: HelloScope.OBSERVE,
    });
    expect(parsed.env).toBe('production');
    expect(parsed.scope).toBe('observe');
  });

  it('keeps a project root, and an older HELLO without one stays valid', () => {
    expect(HelloMessageSchema.parse({ ...base, root: '/remote/app' }).root).toBe('/remote/app');
    expect(HelloMessageSchema.parse(base).root).toBeUndefined();
  });

  it('refuses a word outside the vocabulary', () => {
    expect(HelloMessageSchema.safeParse({ ...base, env: 'staging' }).success).toBe(false);
    expect(HelloMessageSchema.safeParse({ ...base, scope: 'admin' }).success).toBe(false);
  });
});
