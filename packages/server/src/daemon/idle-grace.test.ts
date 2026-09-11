/**
 * The daemon idle-exited at 5 minutes and took the run with it.
 *
 * Evidence from a user's machine: 187 `reticle_daemon_idle_shutdown` lines across
 * ~/.reticle/daemon-*.log, and this cycle repeating in the log —
 *
 *   mcp_client_connected  ->  (5 min quiet)  ->  idle_shutdown  ->  mcp_client_disconnected
 *
 * so their editor's Reticle kept disconnecting. In the fixtures gate the same thing fired during long
 * dependency installs, and the apps that booted afterwards hit ERR_CONNECTION_REFUSED and were scored
 * as INSTALL failures — one of them (cra-redux-saga) has no install defect at all.
 *
 * The rule that causes it was deliberate and must not be reverted: daemons used to sit idle a median
 * of 28 minutes at a 0.04% duty cycle, because "an agent is attached" alone kept them alive for a
 * whole editor session. So an attached-but-unused daemon does still have to go away.
 *
 * The distinction is TIME, not state. Mid-install, an attached daemon is state-identical to one
 * sitting in an empty directory — nothing has been asked of either. What differs is how long it is
 * reasonable to wait: seconds of quiet mean nothing when a client is there and might ask at any
 * moment; the same quiet with nobody attached means the daemon is simply unwanted.
 *
 * So both still exit, on different clocks.
 */

import { describe, expect, it } from 'vitest';
import { idleGraceMs, ATTACHED_GRACE_MULTIPLIER } from './idle-grace.js';

const BASE = 300_000; // the 5 minutes that was killing runs

describe('how long an idle daemon is given', () => {
  it('an UNATTACHED daemon gets the base grace — nobody is waiting on it', () => {
    expect(idleGraceMs(BASE, false)).toBe(BASE);
  });

  it('an ATTACHED daemon gets substantially longer, so an install cannot kill it', () => {
    const attached = idleGraceMs(BASE, true);
    expect(attached).toBeGreaterThan(BASE);
    // Long enough to outlast a slow dependency install, which is what actually happened.
    expect(attached).toBeGreaterThanOrEqual(20 * 60_000);
  });

  it('but it STILL exits — an attached daemon is not immortal', () => {
    // The 28-minute median idle is the regression this must not reintroduce.
    expect(Number.isFinite(idleGraceMs(BASE, true))).toBe(true);
  });

  it('a disabled grace stays disabled whether or not a client is attached', () => {
    // graceMs <= 0 means "never self-shut-down"; multiplying it must not resurrect the timer.
    expect(idleGraceMs(0, true)).toBe(0);
    expect(idleGraceMs(-1, true)).toBeLessThanOrEqual(0);
  });

  it('scales the configured base, so the e2e spec can still drive it fast', () => {
    // apps/e2e/specs/daemon-lifecycle-test.mjs sets a 2s base; the attached case has to stay inside
    // the spec's own wait or the guard becomes a timeout rather than an assertion.
    expect(idleGraceMs(2_000, true)).toBe(2_000 * ATTACHED_GRACE_MULTIPLIER);
  });

  it('honours an explicit attached grace, so a test can drive it directly', () => {
    expect(idleGraceMs(BASE, true, 3_000)).toBe(3_000);
  });

  it('ignores an explicit grace when nothing is attached', () => {
    expect(idleGraceMs(BASE, false, 3_000)).toBe(BASE);
  });
});
