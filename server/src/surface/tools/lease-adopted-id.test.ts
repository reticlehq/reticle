/**
 * A lease must recognise the tab it opened, even when the app named the session itself.
 *
 * `appendReticleParams` stamps `__reticle_session=<leaseId>` on the URL so the app's SDK adopts the
 * lease's identity with no app changes. An app that passes an explicit `session` to `connect()` keeps
 * its own name instead — which is legitimate, and what a single-app fixture does deliberately so a
 * battery can address it by a known id.
 *
 * Readiness was an exact lookup of the lease id, so for those apps it could never be satisfied. The
 * lease returned `ready: false` with a hint saying the tab "never dialled this daemon", and the usual
 * cause is "a PORT MISMATCH" — while a session for that exact URL was connected and driveable at that
 * moment, on that daemon. Seen on next-smoke: `reticle_sessions` listed it one second later with the
 * lease id sitting in its own URL.
 *
 * That is the expensive kind of wrong. The hint sends the reader to check ports, `.reticle.json` and
 * `RETICLE_PORT`, none of which is the problem, and the returned `sessionId` addresses a session that
 * does not exist — so every later call fails too.
 *
 * The URL is the evidence, and the daemon already has it. Resolve the lease to whatever session
 * carries its marker, and return THAT id, because it is the one the agent has to drive with.
 */

import { describe, expect, it } from 'vitest';
import { RETICLE_URL_PARAM } from '@reticlehq/core';
import { resolveLeasedSessionId } from './lease-tools.js';

const LEASE_ID = 'lease-abc';
const leaseUrl = (base: string): string =>
  `${base}?${RETICLE_URL_PARAM.SESSION}=${encodeURIComponent(LEASE_ID)}`;

interface FakeSession {
  id: string;
  url?: string;
}

const sessions = (rows: FakeSession[]) => ({
  get: (id: string): FakeSession | undefined => rows.find((s) => s.id === id),
  all: (): FakeSession[] => rows,
});

describe('a lease resolves to the session its tab actually registered', () => {
  it('uses the lease id when the SDK adopted it', () => {
    const live = sessions([{ id: LEASE_ID, url: leaseUrl('http://localhost:3000/') }]);
    expect(resolveLeasedSessionId(live, LEASE_ID)).toBe(LEASE_ID);
  });

  it('finds a session that kept its OWN name but carries the lease marker', () => {
    // The reported case. The app pinned `session: 'next-smoke'`, so nothing is registered under the
    // lease id — but the tab this lease opened is right there, with the marker in its URL.
    const live = sessions([{ id: 'next-smoke', url: leaseUrl('http://localhost:3100/') }]);
    expect(
      resolveLeasedSessionId(live, LEASE_ID),
      'the returned id is the one the agent has to drive with, so it must be the registered one',
    ).toBe('next-smoke');
  });

  it('does not adopt a session from a DIFFERENT lease', () => {
    // The marker is what makes this safe. Two leases open two tabs, and matching on origin alone
    // would hand the second lease the first one's session.
    const live = sessions([
      { id: 'other', url: `http://localhost:3100/?${RETICLE_URL_PARAM.SESSION}=lease-zzz` },
    ]);
    expect(resolveLeasedSessionId(live, LEASE_ID)).toBe(undefined);
  });

  it('is undefined while nothing has connected, so the hint still fires when it should', () => {
    expect(resolveLeasedSessionId(sessions([]), LEASE_ID)).toBe(undefined);
  });

  it('ignores a session with no url rather than throwing', () => {
    expect(resolveLeasedSessionId(sessions([{ id: 'urlless' }]), LEASE_ID)).toBe(undefined);
  });

  it('does not match a lease id that is merely a PREFIX of another', () => {
    // `lease-abc` must not adopt `lease-abcdef`'s tab. A substring test on the raw URL would.
    const live = sessions([
      { id: 'app', url: `http://localhost:3100/?${RETICLE_URL_PARAM.SESSION}=lease-abcdef` },
    ]);
    expect(resolveLeasedSessionId(live, LEASE_ID)).toBe(undefined);
  });
});
