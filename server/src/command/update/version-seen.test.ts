import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { noteRunningVersion } from './version-seen.js';

/**
 * `version_changed` came only from `reticle update` and `reticle rollback`. An upgrade through
 * `npx @reticlehq/server@latest` never called them, so almost no version change was reported.
 */
describe('a start reports a version move once', () => {
  const stateDir = (): string => mkdtempSync(join(tmpdir(), 'reticle-version-seen-'));

  it('the first start records the version and reports no move', () => {
    expect(noteRunningVersion('3.7.0', stateDir())).toBeUndefined();
  });

  it('a start on a new version reports the move from the last version', () => {
    const dir = stateDir();
    noteRunningVersion('3.7.0', dir);
    expect(noteRunningVersion('3.8.0', dir)).toEqual({
      from: '3.7.0',
      to: '3.8.0',
      direction: 'update',
    });
  });

  it('reports the move once, not on every later start', () => {
    const dir = stateDir();
    noteRunningVersion('3.7.0', dir);
    noteRunningVersion('3.8.0', dir);
    expect(noteRunningVersion('3.8.0', dir)).toBeUndefined();
  });

  it('a start on an older version reports a rollback', () => {
    const dir = stateDir();
    noteRunningVersion('3.8.0', dir);
    expect(noteRunningVersion('3.7.0', dir)?.direction).toBe('rollback');
  });

  it('a record that is not a release version is not sent', () => {
    const dir = stateDir();
    writeFileSync(join(dir, 'last-version'), '/Users/someone/project');
    expect(noteRunningVersion('3.8.0', dir)).toBeUndefined();
  });
});
