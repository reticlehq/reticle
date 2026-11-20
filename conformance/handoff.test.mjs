import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { writeWebHandoff, readWebHandoff } from './handoff.mjs';

/**
 * Remove a temp folder that a test made.
 *
 * On Windows, a folder can stay locked for a short time after a test closes its last handle in it.
 * An antivirus scan, the indexer or a child process that is still exiting can hold it. `rmSync` then
 * throws `EBUSY`, `ENOTEMPTY` or `EPERM`, and the cleanup fails a test that passed (#2158). Node
 * retries exactly these errors when the call passes `maxRetries`.
 */
function removeTempDirSync(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

const directories = [];
afterEach(() => {
  for (const dir of directories.splice(0)) removeTempDirSync(dir);
});

it('a negative control cannot overwrite the real web results compared with desktop', () => {
  const dir = mkdtempSync(join(tmpdir(), 'conformance-handoff-'));
  directories.push(dir);
  const honest = { at: 1, outcomes: { 'nothing-declared': 'passed' } };
  const control = { at: 2, outcomes: { 'nothing-declared': 'failed' } };
  writeWebHandoff(honest, false, dir);
  writeWebHandoff(control, true, dir);
  expect(readWebHandoff(false, dir)).toEqual(honest);
  expect(readWebHandoff(true, dir)).toEqual(control);
  expect(JSON.parse(readFileSync(join(dir, 'web.json'), 'utf8')).outcomes).toEqual(honest.outcomes);
});

it('a standalone desktop control cannot consume a real web run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'conformance-handoff-'));
  directories.push(dir);
  writeWebHandoff({ at: 1, outcomes: { 'nothing-declared': 'passed' } }, false, dir);
  expect(readWebHandoff(true, dir)).toBeUndefined();
});
