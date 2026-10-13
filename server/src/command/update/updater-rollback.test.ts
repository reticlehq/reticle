import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const emit = vi.fn(async () => {});
vi.mock('@/telemetry/telemetry.js', () => ({ getTelemetry: () => ({ emit }) }));
vi.mock('./update-checker.js', () => ({
  loadManifest: () => ({ currentVersion: '9.9.9', previousVersion: '9.9.8' }),
  saveManifest: () => {},
}));

const { rollback } = await import('./updater.js');

describe('rollback under npx', () => {
  const argv1 = process.argv[1];
  beforeEach(() => {
    emit.mockClear();
    process.argv[1] = '/Users/x/.npm/_npx/abc/node_modules/@reticlehq/server/dist/cli.js';
  });
  afterEach(() => {
    process.argv[1] = argv1 ?? '';
  });

  // npx reinstalls nothing (the next start re-resolves the package), yet it reported a rollback that
  // landed: `reticle_rollback_applied` and a `version_changed` ROLLBACK event for a version nobody is
  // running, which is the alarm that says a release broke someone badly enough to go backwards.
  it('reports no rollback, because nothing was rolled back', async () => {
    await rollback();
    expect(emit).not.toHaveBeenCalled();
  });
});
