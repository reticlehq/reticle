/**
 * The three-state answer to "what is on this port".
 *
 * Every honesty defect in the daemon's own reporting comes from collapsing this to two. `isRunning`
 * reads the pid file and never the port, so a port held by a stranger and a port held by nothing
 * produce the same `running: false` — and `serve` then spawns a daemon that cannot bind, reports the
 * spawn, and exits 0. The daemon knew: `reticle_daemon_start_failed / EADDRINUSE` went to a log file
 * nobody reads.
 */
import { describe, it, expect } from 'vitest';
import { PortPresence, classifyPort, describePresence, presenceIsUsable } from './port-presence.js';

describe('classifyPort', () => {
  it('a port that answers /status holds a Reticle daemon', () => {
    expect(classifyPort({ tcpOpen: true, statusAnswered: true })).toBe(PortPresence.DAEMON);
  });

  it('a port that accepts connections but does not answer /status is held by something else', () => {
    // The case that produced the whole bug: `reticle serve` → exit 0, `reticle status` →
    // running:false, and the truth (EADDRINUSE) only in ~/.reticle/daemon-4400.log. A wedged daemon
    // lands here too, which is correct — it is not serving, and saying it "is running" is the lie.
    expect(classifyPort({ tcpOpen: true, statusAnswered: false })).toBe(PortPresence.FOREIGN);
  });

  it('a port nothing accepts on is free', () => {
    expect(classifyPort({ tcpOpen: false, statusAnswered: false })).toBe(PortPresence.FREE);
  });

  it('cannot answer /status without accepting a connection, and says so rather than guessing', () => {
    // Not reachable from a real probe, so it must not be silently folded into DAEMON: a classifier
    // that invents a state for impossible input is how a probe bug becomes a confident all-clear.
    expect(() => classifyPort({ tcpOpen: false, statusAnswered: true })).toThrow(
      /cannot answer .* without accepting/i,
    );
  });
});

describe('presenceIsUsable', () => {
  it('only a daemon is usable', () => {
    expect(presenceIsUsable(PortPresence.DAEMON)).toBe(true);
    expect(presenceIsUsable(PortPresence.FOREIGN)).toBe(false);
    expect(presenceIsUsable(PortPresence.FREE)).toBe(false);
  });
});

describe('describePresence', () => {
  it('names the port and the actual obstacle when something else holds it', () => {
    const said = describePresence(PortPresence.FOREIGN, 4400);
    expect(said).toContain('4400');
    // The one sentence that was never said by any surface. Without the port number and the word
    // "another", the reader goes and checks their app.
    expect(said).toMatch(/another process|not a reticle daemon/i);
  });

  it('does not describe a free port as an error condition', () => {
    expect(describePresence(PortPresence.FREE, 4400)).toMatch(/no daemon|nothing/i);
  });

  it('every state has a sentence — a new state cannot ship without one', () => {
    for (const presence of Object.values(PortPresence)) {
      expect(describePresence(presence, 4400).length).toBeGreaterThan(0);
    }
  });
});

/**
 * Our OWN wedged daemon must not be described as somebody else's process.
 *
 * Found by stress: `SIGSTOP` the daemon and it still accepts TCP but never answers `/status`, so
 * `classifyPort` calls it FOREIGN — which is the right call for *usability* (the port cannot be
 * bound either way) and the wrong thing to SAY. Measured against a frozen daemon on :4411, with
 * `~/.reticle/daemon-4411.pid` holding the exact pid of the frozen process:
 *
 *   reticle doctor → "port 4411 is held by pid 65704 ("node"), which is not a Reticle daemon"
 *
 * It was. The advice that follows — stop that process, or use a different port — sends someone
 * hunting a stranger that does not exist, and the actual fix (`reticle stop`, it respawns) is never
 * mentioned. `status` meanwhile reported `running: true` for the same daemon at the same moment, so
 * the two commands contradicted each other.
 *
 * The classification stays FOREIGN. Only the sentence changes, and only when we can PROVE it is
 * ours — the recorded pid for that port matches the process holding it.
 */
describe('a wedged daemon of our own is named as ours', () => {
  it('says the daemon is not responding when the holder is our recorded pid', () => {
    const msg = describePresence(PortPresence.FOREIGN, 4411, { ourPid: 65704, holderPid: 65704 });
    expect(msg).toContain('not responding');
    expect(msg, 'never call our own daemon a stranger').not.toContain('is not a Reticle daemon');
    expect(msg, 'name the fix that actually works').toMatch(/reticle stop|restart/i);
  });

  it('still calls a genuine stranger a stranger', () => {
    const msg = describePresence(PortPresence.FOREIGN, 4411, { ourPid: 65704, holderPid: 999 });
    expect(msg).toContain('is not a Reticle daemon');
  });

  it('falls back to the stranger wording when we cannot prove ownership', () => {
    expect(describePresence(PortPresence.FOREIGN, 4411)).toContain('is not a Reticle daemon');
    expect(
      describePresence(PortPresence.FOREIGN, 4411, { ourPid: null, holderPid: 999 }),
    ).toContain('is not a Reticle daemon');
  });

  it('leaves the other two states alone', () => {
    expect(describePresence(PortPresence.DAEMON, 4411)).toContain('serving');
    expect(describePresence(PortPresence.FREE, 4411)).toContain('nothing is listening');
  });
});
