/**
 * The handed-over dev server's log had no ceiling. An upstream echo loop (TanStack devtools and
 * Vite 8 forwarding each other's console lines) grew it to 2.9 GB in about five minutes.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoundedLog, ROTATED_SUFFIX } from './dev-server-log-cap.js';

const size = (path: string): number => (existsSync(path) ? statSync(path).size : 0);

describe('the bounded log', () => {
  it('rotates past the cap, keeping the newest output and never more than twice the cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bounded-log-'));
    const path = join(dir, 'dev.log');
    const log = new BoundedLog(path, 1_000);
    for (let i = 0; i < 500; i += 1) log.write(Buffer.from(`line ${String(i)}\n`));
    log.close();
    expect(size(path)).toBeLessThanOrEqual(1_000);
    expect(size(`${path}${ROTATED_SUFFIX}`)).toBeLessThanOrEqual(1_000);
    expect(readFileSync(path, 'utf8')).toContain('line 499');
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps only the tail of one chunk larger than the cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bounded-log-'));
    const path = join(dir, 'dev.log');
    const log = new BoundedLog(path, 100);
    log.write(Buffer.from(`${'x'.repeat(1_000)}END`));
    log.close();
    expect(size(path)).toBe(100);
    expect(readFileSync(path, 'utf8').endsWith('END')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('the supervisor process', () => {
  // Run from the build, as `OwnedDevServer` runs it.
  const script = join(process.cwd(), 'dist/command/setup/bringup/dev-server-log-cap.js');

  it('bounds a server that floods its output, and exits with the server', () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-cap-'));
    const path = join(dir, 'dev.log');
    const flood = `node -e "for (let i = 0; i < 20000; i++) console.log('echo ' + i); process.exitCode = 3"`;
    const run = spawnSync(process.execPath, [script, path, '2000', flood], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(run.status).toBe(3);
    expect(size(path) + size(`${path}${ROTATED_SUFFIX}`)).toBeLessThanOrEqual(4_000);
    expect(readFileSync(path, 'utf8')).toContain('echo 19999');
    rmSync(dir, { recursive: true, force: true });
  }, 25_000);
});
