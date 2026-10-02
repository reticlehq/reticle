/**
 * A non-integer byte offset must be REFUSED here, because one byte further on it kills the daemon.
 *
 * Reported from the field: the daemon died mid-session with
 *
 *     void node::fs::Read(...) Assertion failed: args[3]->IsInt32()
 *       raised from readFileFrom (dist/memory/project/fs/fs-port.js)
 *
 * and port 4400 stopped answering for every later call — including calls from unrelated sessions,
 * because one daemon serves the whole machine.
 *
 * `args[3]` in that internal binding is the READ LENGTH, not the position. `readFileFrom` computes
 * `length = size - start`, so a caller offset that is not an integer makes the length fractional,
 * and a fractional length is not a throwable `RangeError` — it is a V8 assertion that terminates
 * the process. Confirmed by probe: `fh.read(buf, 0, 1.5, 0)` aborts node outright, while a bad
 * POSITION merely rejects. That asymmetry is the whole reason this guard has to exist here rather
 * than being left to the caller: nothing downstream gets a chance to catch it.
 *
 * So the rule is the ordinary trust-boundary one. This is the seam between caller-tracked state and
 * a raw syscall, the syscall's failure mode is fatal rather than recoverable, and the values are
 * cheap to check.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileSystem } from './fs-port.js';

let dir = '';
let file = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reticle-fs-bounds-'));
  file = join(dir, 'events.jsonl');
  writeFileSync(file, 'one\ntwo\nthree\n');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readFileFrom refuses an offset that would reach the syscall malformed', () => {
  const fs = createNodeFileSystem();

  it('rejects a fractional byteOffset rather than aborting the process', async () => {
    await expect(fs.readFileFrom?.(file, 1.5)).rejects.toThrow(/integer/i);
  });

  it('rejects NaN', async () => {
    await expect(fs.readFileFrom?.(file, Number.NaN)).rejects.toThrow(/integer/i);
  });

  it('rejects a negative byteOffset', async () => {
    await expect(fs.readFileFrom?.(file, -1)).rejects.toThrow(/integer/i);
  });

  it('rejects a fractional maxBytes, which lands in the same arithmetic', async () => {
    await expect(fs.readFileFrom?.(file, 0, 2.5)).rejects.toThrow(/integer/i);
  });

  /** The ordinary paths must be untouched — this is a guard, not a behaviour change. */
  it('still reads a whole file from zero', async () => {
    const out = await fs.readFileFrom?.(file, 0);
    expect(out?.text).toBe('one\ntwo\nthree\n');
  });

  it('still reads the tail from a record boundary', async () => {
    const out = await fs.readFileFrom?.(file, 4);
    expect(out?.text).toBe('two\nthree\n');
  });

  it('still honours a byte ceiling and returns whole records', async () => {
    const out = await fs.readFileFrom?.(file, 0, 6);
    expect(out?.text).toBe('three\n');
  });

  it('still returns empty past EOF', async () => {
    const out = await fs.readFileFrom?.(file, 999);
    expect(out?.text).toBe('');
  });
});
