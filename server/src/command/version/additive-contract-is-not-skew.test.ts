/**
 * An addition to the contract is not skew, and the SDK now says enough for us to know that.
 *
 * ── THE INCIDENT ────────────────────────────────────────────────────────────────────────────────
 * `contractParts` was added to the HELLO schema and read by `describeSkew`, and NOTHING EVER
 * PRODUCED IT:
 *
 *     git grep -n contractParts -- '*.ts' | grep -v test
 *     core/src/wire/messages.ts:178          (the schema)
 *     server/src/command/version/version-skew.ts:53,69,117,118   (the reader)
 *
 * So the structural branch was dead on the only peer that matters, every page fell through to the
 * hash, and the hash cannot tell an ADDITION from a RENAME. This release added `scroll`, `tap` and
 * `zoom` to `ActionType` — three names an older page never needs to know — which moves the
 * fingerprint. Anyone upgrading with a pinned SDK would be told, on their first session, that
 * "tools will behave in ways neither side reports", about a change that breaks nothing.
 *
 * `subset-is-not-skew.test.ts` next door already covers the RULE. This covers the WIRING: that the
 * names reach the comparison at all, and what the remaining hash-only case is allowed to claim.
 */

import { describe, expect, it } from 'vitest';
import {
  CONTRACT_PARTS,
  CONTRACT_FINGERPRINT,
  HelloMessageSchema,
  MessageKind,
  RETICLE_PROTOCOL_VERSION,
  TRANSPORT_LIMITS,
} from '@reticlehq/core';
import { describeSkew } from './version-skew.js';

const SELF = {
  version: '3.1.0',
  contract: CONTRACT_FINGERPRINT,
  contractParts: CONTRACT_PARTS,
};

describe('the vocabulary reaches the comparison', () => {
  it('CONTRACT_PARTS names the three vocabularies a peer can speak', () => {
    expect(Object.keys(CONTRACT_PARTS).sort()).toEqual(['actions', 'commands', 'events']);
    for (const names of Object.values(CONTRACT_PARTS)) {
      expect(names.length, 'an empty vocabulary would make every peer a subset').toBeGreaterThan(0);
    }
  });

  it('the actions this release added are in it, so the case under test is the real one', () => {
    // If these ever stop being present the test below proves nothing: it would be comparing two
    // identical lists and calling the result "additive".
    expect(CONTRACT_PARTS.actions).toContain('scroll');
    expect(CONTRACT_PARTS.actions).toContain('tap');
    expect(CONTRACT_PARTS.actions).toContain('zoom');
  });

  it('a page that speaks FEWER names is not skewed, whatever the hashes say', () => {
    const older = {
      what: 'the page',
      version: '2.14.0',
      contract: 'deadbeef', // deliberately different: the hash must not decide this
      contractParts: {
        ...CONTRACT_PARTS,
        actions: CONTRACT_PARTS.actions.filter(
          (name) => name !== 'scroll' && name !== 'tap' && name !== 'zoom',
        ),
      },
      fix: 'update the SDK',
    };
    expect(describeSkew(older, SELF)).toBeUndefined();
  });

  it('a page that speaks a name we do not know IS skewed, and is told which', () => {
    const newer = {
      what: 'the page',
      version: '3.2.0',
      contract: 'deadbeef',
      contractParts: { ...CONTRACT_PARTS, actions: [...CONTRACT_PARTS.actions, 'levitate'] },
      fix: 'update the daemon',
    };
    const message = describeSkew(newer, SELF);
    expect(message).toContain('levitate');
  });

  /*
   * The peer that cannot be fixed by anything we ship today: a 2.x build, which predates the list.
   * It still gets a message — the versions really do differ — but the message may only say what a
   * hash can support.
   */
  it('a page too old to list its names is not told its tools are misbehaving', () => {
    const message =
      describeSkew(
        { what: 'the page', version: '2.14.0', contract: 'deadbeef', fix: 'update the SDK' },
        SELF,
      ) ?? '';
    expect(message).not.toBe('');
    expect(message).toContain('too old to say WHICH names it speaks');
    expect(
      message,
      'a fingerprint cannot support this claim — it answers same-or-different and nothing else',
    ).not.toContain('Tools will behave in ways neither side reports');
  });
});

/**
 * The outage this nearly shipped, pinned so no browser is needed to see it again.
 *
 * `contractParts` reused `MAX_ADAPTERS` (32) as its cap, and this implementation's own event
 * vocabulary is larger than that. Nothing had ever produced the field, so nothing had ever tried to
 * send it — and the first build that did had every HELLO rejected by the schema, so NO SESSION
 * COULD CONNECT. The e2e battery is what caught it; the unit gate could not, because the schema
 * accepts an arbitrary small list in isolation and it takes a real page to send a real one.
 *
 * This is the missing half: validate OUR OWN announcement against the schema that receives it.
 */
describe('the contract we announce survives the schema that receives it', () => {
  it("a HELLO carrying this build's whole vocabulary parses", () => {
    const hello = {
      kind: MessageKind.HELLO,
      protocolVersion: RETICLE_PROTOCOL_VERSION,
      sessionId: 'demo',
      url: 'http://localhost:5173/',
      title: 'demo',
      adapters: [],
      contract: CONTRACT_FINGERPRINT,
      contractParts: {
        commands: [...CONTRACT_PARTS.commands],
        events: [...CONTRACT_PARTS.events],
        actions: [...CONTRACT_PARTS.actions],
      },
    };
    const parsed = HelloMessageSchema.safeParse(hello);
    expect(
      parsed.success,
      parsed.success ? '' : `our own HELLO is rejected: ${JSON.stringify(parsed.error?.issues)}`,
    ).toBe(true);
  });

  it('the cap has real headroom over what we send today', () => {
    const largest = Math.max(
      CONTRACT_PARTS.commands.length,
      CONTRACT_PARTS.events.length,
      CONTRACT_PARTS.actions.length,
    );
    // Not merely "it fits": a cap a single release can grow past is a cap that fails in the field
    // rather than here.
    expect(largest).toBeLessThan(TRANSPORT_LIMITS.MAX_CONTRACT_NAMES);
    expect(largest * 2).toBeLessThan(TRANSPORT_LIMITS.MAX_CONTRACT_NAMES);
  });
});
