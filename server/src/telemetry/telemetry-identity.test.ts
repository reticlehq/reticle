import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveIdentity } from './telemetry.js';

const idPath = (): string =>
  join(mkdtempSync(join(tmpdir(), 'tele-id-')), 'nested', 'telemetry-id');

describe('the anonymous machine id', () => {
  it('is minted and persisted on the first run, then read back', () => {
    const file = idPath();
    const first = resolveIdentity(file);
    expect(first.firstRun).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(first.anonymousId);
    expect(resolveIdentity(file)).toEqual({ anonymousId: first.anonymousId, firstRun: false });
  });

  it('keeps an id another process already wrote rather than replacing it', () => {
    const file = idPath();
    resolveIdentity(file);
    writeFileSync(file, 'theirs', 'utf8');
    expect(resolveIdentity(file)).toEqual({ anonymousId: 'theirs', firstRun: false });
  });

  it('replaces an empty file left behind by a crash', () => {
    const file = idPath();
    resolveIdentity(file);
    writeFileSync(file, '', 'utf8');
    const again = resolveIdentity(file);
    expect(again.firstRun).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(again.anonymousId);
  });
});
