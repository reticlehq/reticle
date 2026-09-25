import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseVerifySuffix } from './cli-parse-verify.js';

const PREDICATE = { kind: 'text', contains: 'Admin' };
const PREDICATE_JSON = JSON.stringify(PREDICATE);

describe('parseVerifySuffix --expect-file', () => {
  it('reads the JSON predicate from a file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'reticle-expect-')), 'expect.json');
    writeFileSync(file, PREDICATE_JSON);
    expect(parseVerifySuffix(['http://localhost:3000', '--expect-file', file], 4400)).toEqual({
      kind: 'ok',
      url: 'http://localhost:3000',
      headless: true,
      port: 4400,
      expect: PREDICATE,
    });
  });

  it('refuses --expect together with --expect-file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'reticle-expect-')), 'expect.json');
    writeFileSync(file, PREDICATE_JSON);
    expect(
      parseVerifySuffix(
        ['http://localhost:3000', '--expect', PREDICATE_JSON, '--expect-file', file],
        4400,
      ),
    ).toEqual({
      kind: 'error',
      message: '--expect and --expect-file cannot both be set: pick one source for the predicate.',
    });
  });

  it('names a missing file', () => {
    const parsed = parseVerifySuffix(
      ['http://localhost:3000', '--expect-file', '/no/such/expect.json'],
      4400,
    );
    expect(parsed.kind).toBe('error');
    expect((parsed as { message: string }).message).toContain('--expect-file');
    expect((parsed as { message: string }).message).toContain('could not read');
  });
});
