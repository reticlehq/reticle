import { describe, it, expect } from 'vitest';
import { checkForUpdate, type UpdateCheckPorts } from './update-checker.js';

interface Manifest {
  currentVersion: string;
  latestVersion?: string;
  updateAvailable: boolean;
  lastChecked: string;
  previousVersion?: string;
}

/** In-memory ports so the network + manifest cache are exercised without touching ~/.reticle or npm. */
function makePorts(
  seed: Manifest | null,
  fetchInfo: UpdateCheckPorts['fetchInfo'],
): {
  ports: UpdateCheckPorts;
  saved: () => Manifest | null;
} {
  let store = seed;
  return {
    ports: {
      fetchInfo,
      loadManifest: () => store,
      saveManifest: (m) => {
        store = m;
      },
    },
    saved: () => store,
  };
}

describe('checkForUpdate', () => {
  it('returns the cached manifest without hitting the registry when the cache is fresh', async () => {
    const now = () => 1000;
    const cached: Manifest = {
      currentVersion: '1.0.0',
      updateAvailable: false,
      lastChecked: new Date(1000).toISOString(),
    };
    const { ports } = makePorts(cached, () =>
      Promise.reject(new Error('must not fetch when cache is fresh')),
    );
    const result = await checkForUpdate('1.0.0', now, ports);
    expect(result).toBe(cached);
  });

  it('falls back to a safe no-update manifest when the registry is unreachable', async () => {
    const { ports } = makePorts(null, () => Promise.reject(new Error('offline')));
    const result = await checkForUpdate('1.0.0', () => 0, ports);
    expect(result.updateAvailable).toBe(false);
    expect(result.currentVersion).toBe('1.0.0');
  });

  it('fetches and reports updateAvailable when the registry has a newer version', async () => {
    const { ports, saved } = makePorts(null, () => Promise.resolve({ version: '2.0.0' }));
    const result = await checkForUpdate('1.0.0', () => 0, ports);
    expect(result.updateAvailable).toBe(true);
    expect(result.latestVersion).toBe('2.0.0');
    expect(saved()?.latestVersion).toBe('2.0.0');
  });
});
