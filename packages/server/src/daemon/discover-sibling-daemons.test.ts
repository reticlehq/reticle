import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverSiblingDaemons } from './daemon.js';

const TEST_HOME = join(tmpdir(), `reticle-sibling-test-${process.pid}`);

function writePid(port: number, pid: number): void {
  writeFileSync(join(TEST_HOME, `daemon-${String(port)}.pid`), String(pid));
}

afterEach(() => {
  try {
    rmSync(TEST_HOME, { recursive: true });
  } catch {
    // already gone
  }
});

describe('discoverSiblingDaemons', () => {
  it('returns live ports other than ownPort', () => {
    mkdirSync(TEST_HOME, { recursive: true });
    writePid(4400, 1001);
    writePid(4460, 1002);
    writePid(4480, 1003);
    const aliveSet = new Set([1001, 1002, 1003]);
    const siblings = discoverSiblingDaemons(4400, TEST_HOME, (pid) => aliveSet.has(pid));
    expect(siblings).toContain(4460);
    expect(siblings).toContain(4480);
    expect(siblings).not.toContain(4400);
  });

  it('excludes dead daemons', () => {
    mkdirSync(TEST_HOME, { recursive: true });
    writePid(4400, 1001);
    writePid(4460, 1002);
    writePid(4480, 9999);
    const siblings = discoverSiblingDaemons(4400, TEST_HOME, (pid) => pid !== 9999);
    expect(siblings).toContain(4460);
    expect(siblings).not.toContain(4480);
  });

  it('returns empty when no state directory exists', () => {
    const siblings = discoverSiblingDaemons(4400, '/nonexistent-path-xyz', () => true);
    expect(siblings).toEqual([]);
  });

  it('returns empty when only ownPort is live', () => {
    mkdirSync(TEST_HOME, { recursive: true });
    writePid(4400, 1001);
    const siblings = discoverSiblingDaemons(4400, TEST_HOME, () => true);
    expect(siblings).toEqual([]);
  });

  it('ignores non-pidfile entries', () => {
    mkdirSync(TEST_HOME, { recursive: true });
    writePid(4460, 1002);
    writeFileSync(join(TEST_HOME, 'pairing-token'), 'abc');
    writeFileSync(join(TEST_HOME, 'not-a-daemon.pid'), '9999');
    const siblings = discoverSiblingDaemons(4400, TEST_HOME, () => true);
    expect(siblings).toEqual([4460]);
  });
});
