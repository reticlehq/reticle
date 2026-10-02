import { describe, expect, it } from 'vitest';
import {
  daemonRegistryFileName,
  daemonRegistryPort,
  pickDaemonPort,
  type DaemonRegistryEntry,
} from './daemon-registry.js';

const entry = (over: Partial<DaemonRegistryEntry>): DaemonRegistryEntry => ({
  port: 4400,
  pid: 100,
  cwd: '/app',
  startedAt: 1,
  ...over,
});

describe('daemon registry filename round-trip', () => {
  it('composes and parses the port', () => {
    expect(daemonRegistryFileName(58432)).toBe('daemon-58432.json');
    expect(daemonRegistryPort('daemon-58432.json')).toBe(58432);
  });

  it('rejects non-registry filenames (pid/log siblings, garbage)', () => {
    expect(daemonRegistryPort('daemon-58432.pid')).toBeNull();
    expect(daemonRegistryPort('daemon-abc.json')).toBeNull();
    expect(daemonRegistryPort('pairing-token')).toBeNull();
  });
});

describe('pickDaemonPort — match by projectId, drop the dead, never guess', () => {
  const allAlive = (): boolean => true;

  it('returns the live daemon whose projectId matches', () => {
    const port = pickDaemonPort(
      [
        entry({ port: 4400, projectId: 'other' }),
        entry({ port: 4460, pid: 200, projectId: 'mine' }),
      ],
      'mine',
      allAlive,
    );
    expect(port).toBe(4460);
  });

  it('lowest port wins when two live daemons match', () => {
    const port = pickDaemonPort(
      [
        entry({ port: 5000, pid: 2, projectId: 'mine' }),
        entry({ port: 4460, pid: 1, projectId: 'mine' }),
      ],
      'mine',
      allAlive,
    );
    expect(port).toBe(4460);
  });

  it('ignores a matching but DEAD daemon (stale entry)', () => {
    const port = pickDaemonPort([entry({ pid: 999, projectId: 'mine' })], 'mine', () => false);
    expect(port).toBeNull();
  });

  it('returns null when no projectId matches — caller falls back, never auto-connects wrong', () => {
    expect(pickDaemonPort([entry({ projectId: 'other' })], 'mine', allAlive)).toBeNull();
  });

  it('returns null when the app has no projectId', () => {
    expect(pickDaemonPort([entry({ projectId: 'mine' })], undefined, allAlive)).toBeNull();
  });
});

/**
 * `init --port <new>` left the old daemon for the same project alive. Discovery by projectId found
 * both, took the lower port, and the page dialled the OLD daemon while init waited on the new one —
 * which it then reported as "connected to a DIFFERENT Reticle daemon" and exited 1.
 */
describe('pickDaemonPort — the configured port wins when a daemon is on it', () => {
  const both = [
    entry({ port: 4400, pid: 1, projectId: 'mine' }),
    entry({ port: 4460, pid: 2, projectId: 'mine' }),
  ];

  it('dials the configured port, not the lowest of this project’s daemons', () => {
    expect(pickDaemonPort(both, 'mine', () => true, 4460)).toBe(4460);
  });

  it('falls back to discovery when nothing live is on the configured port', () => {
    expect(pickDaemonPort(both, 'mine', (pid) => 2 !== pid, 4460)).toBe(4400);
  });

  // Another project's daemon on this project's configured port used to win rule 1, so the page
  // paired with that project's daemon (the pairing token is per machine, not per project) even while
  // this project's own daemon was live on another port.
  it('never lets another project’s daemon on the configured port beat this project’s own', () => {
    const foreignOnConfigured = [
      entry({ port: 4460, pid: 3, projectId: 'other' }),
      entry({ port: 4400, pid: 1, projectId: 'mine' }),
    ];
    expect(pickDaemonPort(foreignOnConfigured, 'mine', () => true, 4460)).toBe(4400);
    expect(pickDaemonPort(foreignOnConfigured.slice(0, 1), 'mine', () => true, 4460)).toBeNull();
  });

  it('still takes the configured port when the daemon there names no project', () => {
    expect(pickDaemonPort([entry({ port: 4460, pid: 3 })], 'mine', () => true, 4460)).toBe(4460);
  });
});
