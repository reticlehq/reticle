import { describe, expect, it, vi } from 'vitest';
import { Declaration, Verdict } from '@reticlehq/openreality';
import { ChannelId, MessageKind, ReticleCommand } from '@reticlehq/core';
import { conformanceClient } from './conformance-client.js';
import { WebRealm } from './web-realm.js';
import { createFakeSession } from '../session/fake-session.js';
import type { Session } from '../session/session.js';

/**
 * Reticle, scored against the specification Reticle publishes.
 *
 * The conformance suite has always said the binding was the reader's problem, which is the right
 * contract and left the author nowhere: we are also an implementation, we had not written ours,
 * and so the suite could not be run against the thing it was written from.
 *
 * The property that matters here is not that it connects. It is that a score produced through
 * this binding comes from `adjudicate` -- the specification's own rules -- and never from
 * Reticle's verdict kernel. Scoring an implementation against its own rules makes every
 * implementation conformant by construction, which is the failure a conformance suite exists to
 * be incapable of.
 */

const answer = (over: { ok: boolean; result?: unknown; error?: string }) =>
  Promise.resolve({ kind: MessageKind.COMMAND_RESULT, id: 'c1', ...over } as const);

const events = [{ type: 'net.response', t: 10, data: { status: 200 } }];

function realmWith(over: Partial<Session> = {}) {
  const session = createFakeSession({
    currentDocumentId: 'doc_1',
    currentEditEpoch: 3,
    channels: [ChannelId.NET, ChannelId.LOG, ChannelId.UI],
    command: vi.fn(() => answer({ ok: true, result: {} })),
    eventsSince: (cursor: number) => events.filter((e) => e.t >= cursor),
    blindSpots: () => ({}),
    lostSince: () => false,
    ...over,
  } as Partial<Session>);
  return new WebRealm({ session, surface: 'web', now: () => 0 });
}

const CLAIM = {
  id: 'c1',
  statement: 'the write reached the server',
  declaredAt: Declaration.BEFORE_ACTION,
  assertions: [{ id: 'a1', predicate: {}, reads: 'POST 200', channels: [ChannelId.NET] }],
};

describe('the driver can reach a live Reticle session', () => {
  it('declares its channels and commands on hello, from the realm', async () => {
    const client = conformanceClient(realmWith(), () => 0);
    const hello = await client.hello();
    expect(hello.channels).toEqual([ChannelId.NET, ChannelId.LOG, ChannelId.UI]);
    expect(hello.commands).toContain(ReticleCommand.ACT);
  });

  it('reports a refused plant as unplantable, never as a silent failure', async () => {
    // The driver scores an unplantable scenario ABSENT, which is honest and is never a pass.
    // A refusal reported as `planted: true` would be scored as a real answer to a question the
    // subject was never put into.
    const client = conformanceClient(realmWith(), () => 0);
    const result = await client.command('x-conformance.plant', { scenario: 'anything' });
    expect(result['planted']).toBe(false);
    expect(String(result['reason'])).toContain('did not declare');
  });
});

describe('the score comes from the specification, not from Reticle', () => {
  it('answers unknown when the claim reads a channel the page never declared', async () => {
    const client = conformanceClient(realmWith({ channels: [ChannelId.UI] }), () => 0);
    const out = await client.verify(CLAIM);
    expect(out.verdict).toBe(Verdict.UNKNOWN);
    expect(out.reason).toMatch(/cannot observe/);
  });

  it('refuses to prove a claim declared after the action', async () => {
    // Reticle's own kernel is more permissive here and reaches `yes`. The specification is not,
    // and a conformance score has to follow the specification -- otherwise the suite measures
    // the implementation against itself.
    const client = conformanceClient(realmWith(), () => 0);
    const out = await client.verify({ ...CLAIM, declaredAt: Declaration.AFTER_ACTION });
    expect(out.verdict).toBe(Verdict.UNKNOWN);
    expect(out.reason).toMatch(/after the action/);
  });

  it('never answers yes from evidence the action itself produced', async () => {
    // The independence rule, reached through the binding rather than asserted about it.
    const uiOnly = realmWith({
      channels: [ChannelId.UI],
      eventsSince: ((cursor: number) =>
        [{ type: 'dom.added', t: 10, data: {}, sessionId: 's' }].filter(
          (e) => e.t >= cursor,
        )) as Session['eventsSince'],
    });
    const out = await conformanceClient(uiOnly, () => 0).verify({
      ...CLAIM,
      assertions: [{ id: 'a1', predicate: {}, reads: 'the badge', channels: [ChannelId.UI] }],
    });
    expect(out.verdict).not.toBe(Verdict.YES);
  });
});
