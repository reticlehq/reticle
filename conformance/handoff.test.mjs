import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { writeWebHandoff, readWebHandoff } from './handoff.mjs';

const directories = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
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
