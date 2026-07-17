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
      [entry({ port: 4400, projectId: 'other' }), entry({ port: 4460, pid: 200, projectId: 'mine' })],
      'mine',
      allAlive,
    );
    expect(port).toBe(4460);
  });

  it('lowest port wins when two live daemons match', () => {
    const port = pickDaemonPort(
      [entry({ port: 5000, pid: 2, projectId: 'mine' }), entry({ port: 4460, pid: 1, projectId: 'mine' })],
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
