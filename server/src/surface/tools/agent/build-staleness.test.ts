import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { STALE_BUILD_NOTICE, buildWatcher } from './build-staleness.js';
import { removeTempDirSync } from '@/machine/temp-dir.test-helpers.js';

let dir = '';
afterEach(() => removeTempDirSync(dir));

describe('a daemon says once that its build on disk is newer than itself', () => {
  it('quiet while nothing changed; says so after a rebuild, and keeps saying it', () => {
    dir = mkdtempSync(join(tmpdir(), 'dist-'));
    const file = join(dir, 'a.js');
    writeFileSync(file, '1');
    utimesSync(file, 1000, 1000);
    let now = 0;
    const check = buildWatcher(dir, () => now);
    now = 60_000;
    expect(check()).toBeUndefined();
    writeFileSync(join(dir, 'b.js'), '2');
    utimesSync(join(dir, 'b.js'), 5000, 5000);
    now = 70_000;
    // Inside the throttle window: not read yet.
    expect(check()).toBeUndefined();
    now = 100_000;
    expect(check()).toBe(STALE_BUILD_NOTICE);
    now = 200_000;
    expect(check()).toBe(STALE_BUILD_NOTICE);
  });
});
