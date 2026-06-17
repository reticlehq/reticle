import { describe, expect, it } from 'vitest';
import { IRIS_PROTOCOL_VERSION, MessageKind, TRANSPORT_LIMITS } from './constants.js';
import { HelloMessageSchema } from './messages.js';

function hello(): Record<string, unknown> {
  return {
    kind: MessageKind.HELLO,
    protocolVersion: IRIS_PROTOCOL_VERSION,
    sessionId: 'demo',
    url: 'http://localhost:3000/',
    title: 'Demo',
    adapters: [],
  };
}

describe('HelloMessageSchema', () => {
  it('accepts a bounded optional pairing token', () => {
    expect(HelloMessageSchema.parse({ ...hello(), token: 'shared-secret' }).token).toBe(
      'shared-secret',
    );
  });

  it('rejects a mismatched protocol version', () => {
    expect(
      HelloMessageSchema.safeParse({ ...hello(), protocolVersion: IRIS_PROTOCOL_VERSION + 1 })
        .success,
    ).toBe(false);
  });

  it('rejects oversized identity fields', () => {
    expect(
      HelloMessageSchema.safeParse({
        ...hello(),
        sessionId: 's'.repeat(TRANSPORT_LIMITS.MAX_SESSION_ID_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});
