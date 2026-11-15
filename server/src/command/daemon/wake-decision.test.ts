/**
 * What the proxy may do when it wakes and finds a daemon on its port.
 *
 * `resolveMcpPort` already refuses to ADOPT a stranger's daemon at boot, and relocates instead. The
 * wake path did not ask the same question: `ensure()` probed for presence and returned the moment a
 * daemon answered `/status`, whoever that daemon belonged to.
 *
 * That gap is reachable by ordinary use. A daemon retires on its idle timer, which frees the port;
 * another project's daemon binds it; the first project's dormant proxy wakes and attaches to it. The
 * agent then drives, asserts and reports a verdict about a DIFFERENT APPLICATION, with nothing
 * anywhere saying so. That is worse than a disconnect: a disconnect is visible, and this is a false
 * green wearing a valid session.
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PortPresence } from './binding/port-presence.js';
import { WakeAction, decideWake, otherProjectRefusal } from './wake-decision.js';

describe('waking onto a port that already has a daemon', () => {
  it('uses our own project’s daemon', () => {
    expect(decideWake(PortPresence.DAEMON, 'app-a', 'app-a')).toBe(WakeAction.USE);
  });

  it('REFUSES a daemon that belongs to a different project', () => {
    expect(decideWake(PortPresence.DAEMON, 'app-b', 'app-a')).toBe(WakeAction.REFUSE);
  });

  /** `init` in `apps/web` replaced the daemon, and the agent at the monorepo root refused it. */
  it('USES a daemon of another id that runs inside the caller project', () => {
    expect(decideWake(PortPresence.DAEMON, 'app-b', 'app-a', true)).toBe(WakeAction.USE);
  });

  // The two escape hatches `adoptable` already documents, restated here because the wake path is
  // where breaking them would lock people out: a daemon that claims no project belongs to whoever
  // asks (the global MCP registration in a directory that is not an app is the ordinary install),
  // and a caller with no project of its own has no identity to defend.
  it('uses an unclaimed daemon', () => {
    expect(decideWake(PortPresence.DAEMON, undefined, 'app-a')).toBe(WakeAction.USE);
  });

  it('uses any daemon when the caller claims no project', () => {
    expect(decideWake(PortPresence.DAEMON, 'app-b', undefined)).toBe(WakeAction.USE);
  });

  it('spawns when the port is free, whatever the identities', () => {
    expect(decideWake(PortPresence.FREE, 'app-b', 'app-a')).toBe(WakeAction.SPAWN);
    expect(decideWake(PortPresence.FREE, undefined, undefined)).toBe(WakeAction.SPAWN);
  });

  it('refuses a foreign listener, as it already did', () => {
    expect(decideWake(PortPresence.FOREIGN, undefined, 'app-a')).toBe(WakeAction.REFUSE);
  });

  // The identity question is asked only of a port that actually holds a daemon. Asking it of a FREE
  // port would refuse to spawn on a port whose registry entry is merely stale, which is the ordinary
  // state of the registry one moment after any daemon exits.
  it('never lets a stale registry entry block a spawn on a free port', () => {
    expect(decideWake(PortPresence.FREE, 'app-b', 'app-a')).not.toBe(WakeAction.REFUSE);
  });
});

/*
 * Reported from the field (3.10.2): after `init` in a monorepo app, both of the agent's proxies at the
 * repo root refused every call with "belongs to a different project ... start this project on its
 * own port". The root's `.reticle.json` named one project, the daemon served the app just wired. The
 * refusal was right and named neither side, so the agent wrote its own HTTP client to get past it.
 */
describe('otherProjectRefusal', () => {
  it('names both projects, where the daemon was started, and how to reach that app', () => {
    const said = otherProjectRefusal({
      port: 4400,
      callerProjectId: 'shop-root-1a2b',
      callerConfigDir: '/repo',
      daemonProjectId: 'web-9f8e',
      daemonCwd: '/repo/apps/web',
    });
    expect(said).toContain('"web-9f8e"');
    expect(said).toContain('/repo/apps/web');
    expect(said).toContain('"shop-root-1a2b"');
    expect(said).toContain('run the agent from /repo/apps/web');
    // Built with the OS separator, as the message builds it (a backslash on Windows).
    expect(said).toContain(join('/repo', '.reticle.json'));
  });

  it('still refuses in words when the daemon left no registry entry', () => {
    const said = otherProjectRefusal({ port: 4400, callerProjectId: 'a' });
    expect(said).toContain('port 4400');
    expect(said).toContain('"a"');
  });
});
