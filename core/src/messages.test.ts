import { describe, expect, it } from 'vitest';
import {
  EventAttribution,
  EventType,
  RETICLE_PROTOCOL_VERSION,
  MessageKind,
  TRANSPORT_LIMITS,
} from './constants.js';
import { MarkAnchorStrategy } from './session-constants.js';
import { HelloMessageSchema, HumanMarkDataSchema, ReticleEventSchema } from './messages.js';

function event(): Record<string, unknown> {
  return { t: 12, type: EventType.DOM_ADDED, sessionId: 'demo' };
}

describe('ReticleEventSchema causal spine', () => {
  it('carries a monotonic seq and an actionId attribution when the SDK stamps them', () => {
    const parsed = ReticleEventSchema.parse({
      ...event(),
      seq: 7,
      actionId: 'act-3',
      attribution: EventAttribution.WINDOW,
    });
    expect(parsed.seq).toBe(7);
    expect(parsed.actionId).toBe('act-3');
    expect(parsed.attribution).toBe(EventAttribution.WINDOW);
  });

  it('stays back-compatible with a pre-2.2 SDK that omits seq/actionId', () => {
    const parsed = ReticleEventSchema.parse(event());
    expect(parsed.seq).toBeUndefined();
    expect(parsed.actionId).toBeUndefined();
    expect(parsed.data).toEqual({});
  });

  it('rejects a negative or non-integer seq', () => {
    expect(ReticleEventSchema.safeParse({ ...event(), seq: -1 }).success).toBe(false);
    expect(ReticleEventSchema.safeParse({ ...event(), seq: 1.5 }).success).toBe(false);
  });

  it('rejects an oversized actionId', () => {
    expect(
      ReticleEventSchema.safeParse({
        ...event(),
        actionId: 'a'.repeat(TRANSPORT_LIMITS.MAX_REF_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown attribution label', () => {
    expect(ReticleEventSchema.safeParse({ ...event(), attribution: 'guessed' }).success).toBe(
      false,
    );
  });
});

describe('EventType', () => {
  it('no longer defines the never-emitted visible.hidden type', () => {
    expect((EventType as Record<string, string>)['VISIBLE_HIDDEN']).toBeUndefined();
  });
});

function hello(): Record<string, unknown> {
  return {
    kind: MessageKind.HELLO,
    protocolVersion: RETICLE_PROTOCOL_VERSION,
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
      HelloMessageSchema.safeParse({ ...hello(), protocolVersion: RETICLE_PROTOCOL_VERSION + 1 })
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

describe('HumanMarkDataSchema', () => {
  it('narrows a full mark with anchor, strategy, label, and source', () => {
    const parsed = HumanMarkDataSchema.parse({
      note: 'This button is misaligned and the label is wrong',
      anchor: 'component:Submit@src/Checkout.tsx:42',
      strategy: MarkAnchorStrategy.COMPONENT,
      label: 'Submit button',
      source: { file: 'src/Checkout.tsx', line: 42 },
      route: '/checkout',
    });
    expect(parsed.source?.line).toBe(42);
    expect(parsed.strategy).toBe(MarkAnchorStrategy.COMPONENT);
  });

  it('accepts the minimal mark (note + anchor + strategy only)', () => {
    expect(
      HumanMarkDataSchema.safeParse({
        note: 'wrong color',
        anchor: 'testid:cta',
        strategy: MarkAnchorStrategy.TESTID,
      }).success,
    ).toBe(true);
  });

  it('rejects an empty note (a mark must say what is wrong)', () => {
    expect(
      HumanMarkDataSchema.safeParse({ note: '', anchor: 'testid:cta', strategy: 'testid' }).success,
    ).toBe(false);
  });

  it('rejects an unknown anchor strategy', () => {
    expect(
      HumanMarkDataSchema.safeParse({ note: 'x', anchor: 'a', strategy: 'guess' }).success,
    ).toBe(false);
  });

  it('rejects an oversized note', () => {
    expect(
      HumanMarkDataSchema.safeParse({
        note: 'n'.repeat(TRANSPORT_LIMITS.MAX_MARK_NOTE_LENGTH + 1),
        anchor: 'testid:cta',
        strategy: 'testid',
      }).success,
    ).toBe(false);
  });
});
