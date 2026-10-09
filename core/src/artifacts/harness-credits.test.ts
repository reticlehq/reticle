import { describe, expect, it } from 'vitest';
import { CreditKind, HarnessConfigSchema } from './impact.js';
import { creditsLeftText, creditsSpent, creditsUsedText } from './harness-credits.js';

describe('the platform credits on the wire', () => {
  it('carries the grant kind, and still reads an older platform that sends none', () => {
    const base = { provider: 'jev', harnessEnabled: true, harnessEntitled: true };
    expect(
      HarnessConfigSchema.parse({ ...base, credits: { used: 2, limit: 10, kind: 'free' } }).credits
        ?.kind,
    ).toBe(CreditKind.FREE);
    expect(HarnessConfigSchema.parse({ ...base, credits: { used: 2, limit: 10 } }).credits).toEqual(
      { used: 2, limit: 10 },
    );
    expect(
      HarnessConfigSchema.safeParse({ ...base, credits: { used: 2, limit: 10, kind: 'gold' } })
        .success,
    ).toBe(false);
  });
});

describe('credits left, said by the grant they came from', () => {
  it('names free and trial grants, and counts any other', () => {
    expect(creditsLeftText({ used: 2, limit: 10, kind: CreditKind.FREE })).toBe(
      '8 of 10 free credits',
    );
    expect(creditsLeftText({ used: 80, limit: 500, kind: CreditKind.TRIAL })).toBe(
      '420 of 500 trial credits',
    );
    expect(creditsLeftText({ used: 300, limit: 4000, kind: CreditKind.PAID })).toBe(
      '3,700 of 4,000 credits left',
    );
    expect(creditsLeftText({ used: 1, limit: 50 })).toBe('49 of 50 credits left');
  });

  it('is spent only at the limit, and never for an unbounded plan', () => {
    expect(creditsSpent({ used: 10, limit: 10 })).toBe(true);
    expect(creditsSpent({ used: 9, limit: 10 })).toBe(false);
    expect(creditsSpent(undefined)).toBe(false);
  });
});

describe('credits used up, said the same on the HUD and in the terminal', () => {
  it('free: the number the platform granted, and the trial a card starts', () => {
    expect(creditsUsedText({ used: 25, limit: 25, kind: CreditKind.FREE })).toEqual({
      said: 'Your 25 free credits are used.',
      action: 'Add a card to start your 14-day trial',
    });
  });

  it('trial: the trial grant, and when Pro starts; no offer to buy more', () => {
    expect(creditsUsedText({ used: 500, limit: 500, kind: CreditKind.TRIAL })).toEqual({
      said: 'Your 500 trial credits are used. Pro starts when your trial ends.',
    });
  });

  it('paid: when they renew', () => {
    expect(creditsUsedText({ used: 4000, limit: 4000, kind: CreditKind.PAID })).toEqual({
      said: "This month's credits are used. They renew over the next 30 days.",
    });
  });
});
