import { describe, expect, it } from 'vitest';
import { EVENT_PAYLOAD_SCHEMAS, EventType, Verified } from '@reticlehq/core';
import { barestEvents } from './adversary.js';
import { findContradictions } from '../disagreement/contradictions.js';
import { decideVerified } from '../evidence/verified.js';
import { buildHonestyBlock } from '../evidence/honesty.js';

/**
 * What happens when the page tells us the bare minimum.
 *
 * Every optional field on the wire exists because some client could not supply it. The readers are
 * written to cope, and this checks that claim across all of them at once instead of one fixture at a
 * time -- because every fixture in this repository was written by somebody who knew what the code
 * wanted, and a real minimal client was not.
 */

describe('an SDK that says the least it can', () => {
  const events = barestEvents();

  it('produces one event of every kind the wire knows about', () => {
    // The premise. If a new event type stops being generated, everything below quietly checks less.
    expect(events).toHaveLength(Object.values(EventType).length);
  });

  it('and every one of them is VALID — this is not malformed input', () => {
    // The distinction that makes this worth having. Malformed input is already refused by the
    // schemas, and a refusal is a good outcome. This is input the contract fully accepts and which
    // offers nothing, which is a different thing entirely and the one nobody had tried.
    for (const event of events) {
      const schema = EVENT_PAYLOAD_SCHEMAS[event.type];
      const parsed = schema.safeParse(event.data);
      expect(parsed.success, `${event.type}: ${JSON.stringify(event.data)}`).toBe(true);
    }
  });

  it('the finding engine reads them all without throwing', () => {
    // A throw here would take down assert, act_and_wait, observe and crawl at once, for a page that
    // did nothing wrong.
    expect(() => findContradictions(events, {})).not.toThrow();
  });

  it('one at a time as well, so a crash cannot hide behind its neighbours', () => {
    for (const event of events) {
      expect(() => findContradictions([event], {}), event.type).not.toThrow();
    }
  });

  it('and never turns silence into a finding', () => {
    // The rule this file exists for. An empty field is "we were not told", and a rule that reads it
    // as "it did not happen" invents a defect in an app that is behaving.
    expect(findContradictions(events, {})).toHaveLength(0);
  });
});

describe('a verdict over a page that told us nothing', () => {
  it('is not a pass', () => {
    // The other half of the same rule, on the surface that matters most. Nothing was declared and
    // nothing was observed, so there is nothing to have proved.
    const decision = decideVerified({
      pass: true,
      honesty: buildHonestyBlock({ grade: 'none', attribution: 'window' }),
    });
    expect(decision.verified).not.toBe(Verified.YES);
  });

  it('and is not a failure either — an app is not broken because its SDK is quiet', () => {
    const decision = decideVerified({
      pass: true,
      honesty: buildHonestyBlock({ grade: 'none', attribution: 'window' }),
    });
    expect(decision.verified).not.toBe(Verified.NO);
  });
});
