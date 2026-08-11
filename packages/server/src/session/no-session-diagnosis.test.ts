/**
 * The message that ends most sessions.
 *
 * Measured over yesterday's telemetry: of the 25 sessions that called any tool, 13 made exactly ONE
 * call and stopped — 8 of them `reticle_sessions` — and 10 of those 13 never touched a browser.
 * Every recorded session error is the same one:
 *
 *   "no browser session connected. Two things to check: (1) your app is running with
 *    @reticlehq/browser enabled, and (2) it points at THIS daemon's port"
 *
 * It is accurate and it is fatal. It names two things the agent cannot check from where it stands
 * and gives it nothing to DO, so the agent abandons the tool for the rest of the session. 74% of
 * sessions never call a tool at all, and this is what greets most of the ones that try.
 *
 * The daemon can tell these three cases apart, and they have completely different next actions:
 *   - nothing is listening anywhere       -> the dev server is not running; start it
 *   - something is listening, never dialled -> the SDK is not wired into that app; run `reticle init`
 *   - a session was connected and went away -> the tab closed or reloaded; reopen/reload it
 *
 * Today all three produce the same dead end.
 */

import { describe, expect, it } from 'vitest';
import { diagnoseNoSession } from './no-session-diagnosis.js';

describe('diagnoseNoSession', () => {
  it('a session was here and left — say so, and say what to do', () => {
    const msg = diagnoseNoSession({
      everConnected: true,
      initialized: true,
      listening: [],
      port: 4400,
    });
    expect(msg).toMatch(/was connected|disconnected|reload/i);
    // Never send someone to check the install when the install demonstrably worked.
    expect(msg).not.toMatch(/reticle init/);
  });

  it('a dev server is up but never dialled — name the port, and point at the wiring', () => {
    const msg = diagnoseNoSession({
      everConnected: false,
      initialized: false,
      listening: [5173],
      port: 4400,
    });
    expect(msg).toContain('5173');
    expect(msg).toContain('reticle init');
    // The actionable half: the app is RUNNING, so "is your app running?" is the wrong question.
    expect(msg).toMatch(/not wired|never connected|no Reticle SDK/i);
  });

  it('a dev server is up and the project IS wired — then it is the port or a stale build', () => {
    const msg = diagnoseNoSession({
      everConnected: false,
      initialized: true,
      listening: [3000],
      port: 4400,
    });
    expect(msg).toContain('3000');
    expect(msg).toContain('4400');
    expect(msg).toMatch(/restart|reload|port/i);
    expect(msg).not.toMatch(/reticle init/);
  });

  it('nothing is listening at all — the app is simply not running', () => {
    const msg = diagnoseNoSession({
      everConnected: false,
      initialized: true,
      listening: [],
      port: 4400,
    });
    expect(msg).toMatch(/no dev server|not running/i);
    // Do not ask the agent to check the SDK when there is no app to have an SDK in.
    expect(msg).not.toMatch(/reticle init/);
  });

  it('names every listening candidate, not just the first', () => {
    const msg = diagnoseNoSession({
      everConnected: false,
      initialized: true,
      listening: [3000, 5173],
      port: 4400,
    });
    expect(msg).toContain('3000');
    expect(msg).toContain('5173');
  });

  /**
   * The branch where the agent does not need the human at all.
   *
   * `reticle_lease` opens a browser Reticle controls instead of waiting for the human's tab to dial
   * in. Measured over a day: the 5 sessions that used it had a MEDIAN of 30 tool calls and produced
   * 46% of every bug found, against a median of 1 call for the 20 active sessions that did not — and
   * not one single-call bounce used a lease. It is the difference between working and bouncing.
   *
   * It is also advertised on NO profile but `full`, so an agent finds it only if it already knew.
   * The moment it matters is exactly here, so this is where it gets named — at no per-turn cost.
   */
  it('offers self-service driving when the app is wired but no tab is open', () => {
    const msg = diagnoseNoSession({
      everConnected: false,
      initialized: true,
      listening: [5173],
      port: 4400,
    });
    expect(msg).toContain('reticle_lease');
    // Advertised only under `full`; everywhere else it is reached through the meta-tool.
    expect(msg).toContain('reticle_run');
  });

  it('offers it again when a tab was connected and went away', () => {
    const msg = diagnoseNoSession({
      everConnected: true,
      initialized: true,
      listening: [5173],
      port: 4400,
    });
    expect(msg).toContain('reticle_lease');
  });

  it('does NOT offer it when the app has no SDK — a leased tab would never dial in either', () => {
    const msg = diagnoseNoSession({
      everConnected: false,
      initialized: false,
      listening: [5173],
      port: 4400,
    });
    expect(msg).not.toContain('reticle_lease');
  });

  it('does NOT offer it when nothing is running — there is nothing to open', () => {
    const msg = diagnoseNoSession({
      everConnected: false,
      initialized: true,
      listening: [],
      port: 4400,
    });
    expect(msg).not.toContain('reticle_lease');
  });

  it('always ends with something the agent can DO', () => {
    for (const input of [
      { everConnected: true, initialized: true, listening: [], port: 4400 },
      { everConnected: false, initialized: false, listening: [5173], port: 4400 },
      { everConnected: false, initialized: true, listening: [], port: 4400 },
    ]) {
      const msg = diagnoseNoSession(input);
      expect(msg.length, JSON.stringify(input)).toBeGreaterThan(40);
      // An imperative, not a description of the world.
      expect(msg, JSON.stringify(input)).toMatch(/start |run |reload|reopen|restart|check /i);
    }
  });
});

/**
 * An empty result from an eleven-port scan is not evidence of absence.
 *
 * Reported from a scripted drive of published 2.5.0: the diagnosis asserted the app was not running
 * while it was serving 200 on `:7699`. `DEV_SERVER_PORTS` is a fixed set of eleven, and it does not
 * contain 7699 — nor 4310 (our own bench-app), 3100 (next-smoke), 5175 (a second Vite on a machine
 * already running one), 1420 (Tauri), 4173 (`vite preview`), or anything a user passed to --port.
 *
 * The narrow claim was true. The two sentences built on top of it — "the app is almost certainly not
 * running" and "this is not a Reticle wiring problem" — are neither, and the message is DIRECTIVE:
 * the agent is the audience and it is being told to stop looking. That is the expensive part. A
 * caveat costs a sentence; sending an agent away from a working app costs the session.
 */
describe('the no-listener branch does not overclaim what an eleven-port scan proved', () => {
  const scanned = diagnoseNoSession({
    everConnected: false,
    initialized: true,
    listening: [],
    port: 4400,
  });

  it('does not assert the app is not running', () => {
    expect(scanned).not.toMatch(/almost certainly not running/i);
  });

  it('does not tell the agent this cannot be a Reticle problem', () => {
    // The directive half. Reticle cannot know this, and saying it ends the investigation.
    expect(scanned).not.toMatch(/not a Reticle wiring problem/i);
  });

  it('says what it actually checked, so the reader can judge the gap', () => {
    expect(scanned).toMatch(/\b5173\b/);
    expect(scanned).toMatch(/scan|checked|only|these ports/i);
  });

  it('gives the agent a way to proceed when the app IS running elsewhere', () => {
    expect(scanned).toMatch(/reticle_lease|url/i);
  });

  it('still leads with the likeliest cause — a caveat must not bury the common case', () => {
    // The scan is usually right. This must stay useful for the user whose server really is down,
    // not become a hedge that says nothing.
    expect(scanned).toMatch(/dev server|npm run dev/i);
  });
});

/**
 * A lease that aged out must not be reported as a human closing a tab.
 *
 * Reported from the field (#157): when a pooled lease expires, the agent gets the `everConnected`
 * message — "The tab was closed, navigated away, or hard-reloaded. Ask the human to reopen the app"
 * — and none of it is true. There is no human tab; the lease simply aged out, and the fix is a
 * re-acquire the agent can do itself. The reporter said it "sent me looking for a port mismatch".
 *
 * That is the same defect as the eleven-port scan: a message asserting one specific cause and one
 * specific fix, both wrong, to an audience that will act on it. Here it is worse than a dead end,
 * because the recovery it names (ask a human) is unavailable to the caller and the one that would
 * work (`reticle_lease { action: "acquire" }`) is not mentioned.
 *
 * `leaseExpired` is "this daemon has reaped at least one expired lease", NOT "the session that just
 * vanished was that lease" — nothing knows that. So the message leads with the lease because a reap
 * is a fact, and still admits the tab case rather than swapping one false certainty for another.
 */
describe('a reaped lease is not reported as a closed tab', () => {
  const afterReap = diagnoseNoSession({
    everConnected: true,
    initialized: true,
    listening: [5173],
    port: 4400,
    leaseExpired: true,
  });

  it('does not assert that a human closed the tab', () => {
    expect(afterReap).not.toMatch(/tab was closed, navigated away, or hard-reloaded/i);
  });

  it('names the lease AGEING OUT as the likely cause', () => {
    // Deliberately not just /lease/: the existing message already mentions `reticle_lease` in its
    // self-serve hint, so a looser assertion here would pass without the fix and prove nothing.
    expect(afterReap).toMatch(/expired|aged out/i);
  });

  it('tells the agent to re-acquire rather than to fetch a human', () => {
    expect(afterReap).toMatch(/acquire/i);
    expect(afterReap).not.toMatch(/Ask the human to reopen/i);
  });

  it('still keeps the old message when no lease was ever reaped', () => {
    // The control. Most sessions are human tabs, and that message is right for them.
    const plain = diagnoseNoSession({
      everConnected: true,
      initialized: true,
      listening: [5173],
      port: 4400,
    });
    expect(plain).toMatch(/tab was closed, navigated away, or hard-reloaded/i);
  });
});
