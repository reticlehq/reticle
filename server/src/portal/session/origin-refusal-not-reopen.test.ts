/**
 * A page turned away at the origin gate is not a closed tab.
 *
 * Reported from the field: a multi-tenant app on a `*.test` host connected once, then every dial was
 * refused at the origin gate. `reticle_session list` and `status` said "a session was connected to
 * this daemon earlier, so the wiring is correct" and told the agent to reopen the app. Reopening
 * dials again and is refused again. The fix, `RETICLE_ALLOWED_ORIGINS`, was only in the daemon log.
 *
 * The bridge already records the origin refusal with the fix in it. The diagnosis left it out
 * because the origin gate refuses before any hello, so the closure carries no page. It is still a
 * current, positive refusal, and it outranks "somebody connected once".
 */
import { describe, expect, it } from 'vitest';
import { NoSessionAction } from '@reticlehq/core';
import { originRejectedReason } from '@/portal/bridge/auth-failure-reason.js';
import { startNoSessionWatch } from './no-session-watch.js';
import type { NoSessionNextAction } from './no-session-next-action.js';
import type { SessionManager } from './session-manager.js';

const ORIGIN = 'http://tenant.myapp.test:3000';

/** A manager that once had a session, and whose last bridge close is an origin refusal. */
function refusedAtOrigin(connectedSince: boolean): {
  manager: SessionManager;
  hint: () => string;
  next: () => NoSessionNextAction | undefined;
} {
  let installed: (() => string | undefined) | undefined;
  let nextAction: (() => NoSessionNextAction | undefined) | undefined;
  const manager = {
    count: () => 0,
    everConnected: () => true,
    lastDeparted: () => undefined,
    lastClosure: () => ({ at: 1000, reason: originRejectedReason(ORIGIN) }),
    connectedSinceLastClosure: () => connectedSince,
    setNoSessionReason: () => {},
    setNoSessionHint: (hint: (() => string | undefined) | undefined) => {
      installed = hint;
    },
    setNoSessionLead: () => undefined,
    setNoSessionNextAction: (next: (() => NoSessionNextAction | undefined) | undefined) => {
      nextAction = next;
    },
    setConnectionRecorder: () => undefined,
  } as unknown as SessionManager;
  return { manager, hint: () => installed?.() ?? '', next: () => nextAction?.() };
}

function watch(connectedSince: boolean): { hint: string; next: NoSessionNextAction | undefined } {
  const { manager, hint, next } = refusedAtOrigin(connectedSince);
  const stop = startNoSessionWatch({
    sessions: manager,
    port: 4400,
    initialized: true,
    probe: () => Promise.resolve([3000]),
  });
  const out = { hint: hint(), next: next() };
  stop();
  return out;
}

describe('a page refused at the origin gate after an earlier session', () => {
  it('names the origin and the allow-list, not a closed tab', () => {
    const { hint, next } = watch(false);
    expect(hint).toContain('tenant.myapp.test');
    expect(hint).toContain('RETICLE_ALLOWED_ORIGINS');
    expect(next?.reason ?? '').toContain('RETICLE_ALLOWED_ORIGINS');
    expect(next?.action).not.toBe(NoSessionAction.REOPEN_APP);
    expect(next?.reason ?? '').not.toMatch(/wiring is correct/i);
  });

  it('goes back to the closed-tab advice once a session got in after the refusal', () => {
    // The negative control: an old origin refusal must not blame the origin for a tab the human closed.
    const { next } = watch(true);
    expect(next?.action).toBe(NoSessionAction.REOPEN_APP);
  });
});
