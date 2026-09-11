import { describe, expect, it, vi } from 'vitest';
import {
  adjudicate,
  ChannelId as ProtocolChannel,
  CloseCondition,
  Declaration,
  Grade,
  Profile,
  profileFromChannels,
  ProvenanceClass,
  RefusalReason,
  Verdict,
} from '@reticlehq/openreality';
import { AppRuntime, ChannelId, MessageKind, ReticleCommand } from '@reticlehq/core';
import { WebRealm } from './web-realm.js';
import { createFakeSession } from '../session/fake-session.js';
import type { Session } from '../session/session.js';

/**
 * Reticle's own realms, scored against the specification Reticle publishes.
 *
 * The point is not that the adapter compiles. It is that the two surfaces this product actually
 * ships can answer the eight questions, declare honestly what they cannot see, and reach a
 * verdict through the SAME realm-blind adjudicator as a realm with no screen at all. An author
 * who cannot demonstrate that has published an interface and a hope.
 */

// The session's clock: elapsed milliseconds since connect, which is the domain every event in
// the buffer is stamped in. Starting a test at a wall-clock number is what hid the cursor bug.
const clock = 0;

/**
 * A real `Session` with the three answers this file asserts on.
 *
 * `createFakeSession` rather than a hand-rolled `Partial<Session> as Session`, which is what the
 * first draft of this file was. The cast silences the type system, so a method added to `Session`
 * compiles here and throws at runtime — a mistake this repository has now made eight times, and
 * built this helper to stop making. Being the eighth would have been particularly poor in a file
 * whose subject is following one's own rules.
 */
function fakeSession(over: Partial<Session> = {}): Session {
  // Stamped AFTER the window opens, which is the real ordering: open, act, observe. A fixture
  // whose events predate the window is testing a situation that cannot occur.
  const events = [
    { type: 'net.response', t: 10, data: { status: 200, url: '/orders' } },
    { type: 'dom.added', t: 12, data: { count: 1 } },
    { type: 'x.unknown', t: 13, data: {} },
  ];
  return createFakeSession({
    currentDocumentId: 'doc_7k2m',
    currentEditEpoch: 7,
    channels: [ChannelId.UI, ChannelId.NET, ChannelId.LOG, ChannelId.TIME],
    command: vi.fn(() => answer({ ok: true, result: { ok: true } })),
    // Timestamp-based, like the real ring buffer. Index-based was the assumption that produced
    // the cursor bug this fixture now pins.
    eventsSince: (cursor: number) => events.filter((e) => e.t >= cursor),
    blindSpots: () => ({ 'cross-origin-iframe': 1 }),
    lostSince: () => false,
    ...over,
  } as Partial<Session>);
}

/**
 * A complete `CommandResult`, because the real `Session` type insists on one.
 *
 * The first draft returned `{ ok: true, result: {} }` through an `as Session` cast and compiled
 * happily. Using the real session factory turned that into a type error, which is the whole
 * argument for the factory in one line.
 */
const answer = (over: { ok: boolean; result?: unknown; error?: string }) =>
  Promise.resolve({ kind: MessageKind.COMMAND_RESULT, id: 'cmd-1', ...over } as const);

const realm = (over = {}) => new WebRealm({ session: fakeSession(over), now: () => clock });

describe('the web realm answers the protocol', () => {
  it('reports an identity that dies with the document, carrying the edit round', () => {
    const id = realm().identity();
    expect(id.surface).toBe('web');
    expect(id.instance).toBe('doc_7k2m');
    expect(id.epoch).toBe(7);
  });

  it('falls back to the session id only before a document is known, never instead of one', () => {
    // The fallback is a WEAKER identity: it survives a navigation that should have invalidated it.
    // Using it as a substitute rather than as a bootstrap would silently re-introduce stale
    // evidence, which is the failure `instance` exists to prevent.
    const id = realm({ currentDocumentId: undefined }).identity();
    expect(id.instance).toBe(fakeSession({ currentDocumentId: undefined }).id);
  });

  it('reports the channels the page declared, at this specification’s grades', () => {
    const declared = realm().channels();
    expect(declared.map((c) => c.id).sort()).toEqual(['log', 'net', 'time', 'ui']);
    expect(declared.find((c) => ProtocolChannel.NET === c.id)?.grade).toBe(Grade.CONSEQUENCE);
    expect(declared.find((c) => ProtocolChannel.UI === c.id)?.independence).toBe(
      'actuation-derived',
    );
  });

  it('reports NO channels for an SDK too old to declare, rather than hoping', () => {
    // The loud answer is the correct one. A hopeful default here would restore the exact bug the
    // declaration was added to remove, in the one file most likely to be trusted.
    expect(realm({ channels: undefined }).channels()).toEqual([]);
    expect(realm({ channels: undefined }).canProveAnything()).toBe(false);
  });

  it('earns the surface profile when the page declares the full set', () => {
    const full = realm({
      channels: [ChannelId.NET, ChannelId.LOG, ChannelId.STATE, ChannelId.SIGNAL, ChannelId.UI],
    });
    expect(profileFromChannels(full.channels())).toBe(Profile.SURFACE);
  });

  it('earns only effect when the page has no store adapter', () => {
    const noStore = realm({ channels: [ChannelId.NET, ChannelId.LOG] });
    expect(profileFromChannels(noStore.channels())).toBe(Profile.EFFECT);
  });
});

describe('it refuses rather than approximating', () => {
  it('refuses an undeclared capability without reaching the page at all', async () => {
    // The spy is held directly rather than reached through the session, so nothing here passes a
    // method around detached from its object.
    const command = vi.fn(() => answer({ ok: true, result: {} }));
    const session = fakeSession({ command });
    const receipt = await new WebRealm({ session, now: () => clock }).perform({
      id: 'a1',
      actor: 'test',
      capability: 'drop_database',
      at: clock,
    });
    expect(receipt.dispatched).toBe(false);
    expect(receipt.refused?.reason).toBe(RefusalReason.UNDECLARED);
    expect(command).not.toHaveBeenCalled();
  });

  it('treats a page that answered no as a refusal, not as a failing application', async () => {
    // Nothing was learned about whether the consequence would have held. Recording it as a
    // failure would put the tool's own inability into the application's bug count.
    const receipt = await realm({
      command: vi.fn(() => answer({ ok: false, error: 'the element is disabled' })),
    }).perform({ id: 'a1', actor: 'test', capability: ReticleCommand.ACT, at: clock });
    expect(receipt.dispatched).toBe(false);
    expect(receipt.refused?.reason).toBe(RefusalReason.UNAVAILABLE);
    expect(receipt.refused?.detail).toContain('disabled');
  });

  it('marks mutating capabilities, so a crawl does not explore by placing orders', () => {
    const caps = realm().capabilities();
    expect(caps.find((c) => ReticleCommand.ACT === c.name)?.mutating).toBe(true);
    expect(caps.find((c) => ReticleCommand.SNAPSHOT === c.name)?.mutating).toBe(false);
  });
});

describe('observations belong to the window that was open', () => {
  it('reads the window by TIME, not by a count of events', async () => {
    // The bug this file found. `eventsSince` binary-searches timestamps; seeding it with the
    // buffer's length meant "everything from millisecond three onward" — wrong events on a young
    // session, none at all on an old one, and the second reads as a page that did nothing.
    const r = realm();
    const window = r.openWindow(8_000);
    expect(window.openedAt).toBe(0);
    expect(await r.observe(window)).not.toHaveLength(0);
  });

  it('attributes each event to the channel that produced it', async () => {
    const r = realm();
    const window = r.openWindow(8_000);
    const seen = await r.observe(window);
    expect(seen.map((o) => o.channel)).toEqual([ProtocolChannel.NET, ProtocolChannel.UI]);
    expect(seen.every((o) => window.id === o.window)).toBe(true);
  });

  it('drops an event whose source it cannot name, rather than guessing one', async () => {
    // An observation attributed to a channel that did not produce it is worse than an observation
    // nobody has: it can be weighed for independence, and the weighing will be wrong.
    const r = realm();
    const seen = await r.observe(r.openWindow(8_000));
    expect(seen.some((o) => 'x.unknown' === o.summary)).toBe(false);
  });

  it('names every channel the page did not declare, rather than leaving it implied', async () => {
    const r = realm();
    const coverage = await r.coverage(r.openWindow(8_000));
    const unobserved = coverage.blindSpots.filter((s) => 'channel-unobserved' === s.kind);
    expect(unobserved.map((s) => s.channel)).toContain(ProtocolChannel.STATE);
    expect(unobserved.map((s) => s.channel)).toContain(ProtocolChannel.SIGNAL);
  });

  it('leaves impeachment to the adjudicator, which is the only thing that sees the claim', async () => {
    // A realm deciding the relevance of its own gaps is the observer grading its own blind spots.
    const r = realm();
    const coverage = await r.coverage(r.openWindow(8_000));
    expect(coverage.blindSpots.every((spot) => false === spot.impeaching)).toBe(true);
  });
});

describe('it reaches a verdict through the same rules as a realm with no screen', () => {
  it('proves a net claim from the page’s own independent evidence', async () => {
    const r = realm();
    const window = { ...r.openWindow(8_000), closedAt: 50, closedBy: CloseCondition.QUIESCENCE };
    const observations = await r.observe(window);
    const net = observations.find((o) => ProtocolChannel.NET === o.channel);
    if (net === undefined) throw new Error('the net observation this case is about was not made');
    const result = adjudicate({
      claim: {
        id: 'c1',
        statement: 'the order posted',
        declaredAt: Declaration.BEFORE_ACTION,
        assertions: [
          { id: 'a1', predicate: {}, reads: 'POST /orders 200', channels: [ProtocolChannel.NET] },
        ],
      },
      window,
      channels: r.channels(),
      evidence: [
        {
          observation: net,
          provenance: {
            class: ProvenanceClass.OBSERVED,
            source: 'reticle-sdk',
            method: 'patched fetch',
            subject: r.identity(),
            at: net.at,
          },
          independence: 'independent',
          grade: Grade.CONSEQUENCE,
        },
      ],
      coverage: { window: window.id, observed: r.channels().map((c) => c.id), blindSpots: [] },
      anomalies: [],
      assertionsHeld: true,
    });
    expect(result.verdict).toBe(Verdict.YES);
  });

  it('cannot prove a state claim the page never said it could see', async () => {
    const r = realm();
    const window = { ...r.openWindow(8_000), closedAt: 50, closedBy: CloseCondition.QUIESCENCE };
    const result = adjudicate({
      claim: {
        id: 'c1',
        statement: 'the cart is paid',
        declaredAt: Declaration.BEFORE_ACTION,
        assertions: [
          { id: 'a1', predicate: {}, reads: 'cart.status', channels: [ProtocolChannel.STATE] },
        ],
      },
      window,
      channels: r.channels(),
      evidence: [],
      coverage: await r.coverage(window),
      anomalies: [],
      assertionsHeld: true,
    });
    expect(result.verdict).toBe(Verdict.UNKNOWN);
    expect(result.reasons.join(' ')).toMatch(/cannot observe/);
  });
});

describe('desktop is the same realm with a different camera', () => {
  /** A session on a desktop shell, as the SDK reports it in the handshake. */
  const onDesktop = { runtime: AppRuntime.TAURI } as Partial<Session>;

  it('answers identity, channels and actions identically', () => {
    const web = realm();
    const desktop = realm(onDesktop);
    expect(desktop.identity().instance).toBe(web.identity().instance);
    expect(desktop.channels()).toEqual(web.channels());
    expect(desktop.capabilities()).toEqual(web.capabilities());
  });

  it('reads the surface off the shell the SDK reported, not off a parameter', () => {
    // The surface used to be handed in, and every caller in the repository handed in `web` --
    // so `desktop` had never been the surface of anything, however many Electron and Tauri
    // sessions had connected. Deriving it removes the way to be wrong.
    expect(realm({ runtime: AppRuntime.TAURI }).identity().surface).toBe('desktop');
    expect(realm({ runtime: AppRuntime.ELECTRON }).identity().surface).toBe('desktop');
    expect(realm({ runtime: AppRuntime.WEB }).identity().surface).toBe('web');
    // An SDK too old to report one. `web` is an assumption, and the weaker of the two: a desktop
    // app identified as a page understates the subject rather than misdescribing it.
    expect(realm({ runtime: undefined }).identity().surface).toBe('web');
  });

  it('refuses to invent a picture when the shell returned none', async () => {
    // A realm that pretends to have taken a picture is worse than one that admits it cannot: an
    // empty buffer saved as a baseline is a comparison that passes forever.
    const r = realm({ ...onDesktop, command: vi.fn(() => answer({ ok: true, result: {} })) });
    await expect(r.photograph()).rejects.toThrow(/must not pretend/);
  });
});
