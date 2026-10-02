/**
 * `--expect` on a Windows shell.
 *
 * The no-MCP verdict path is the highest-count unbuilt ask in the field dataset, and the thing that
 * stops it on Windows is quoting. `cmd.exe` does not treat `'` as a quote character at all, so a
 * command copied from the README arrives with LITERAL single quotes wrapped around the JSON; that
 * one is unambiguous and is simply undone. PowerShell calling a native executable strips the inner
 * double quotes instead, and what arrives is not JSON and cannot be repaired without guessing what
 * was a key and what was a string, so it is NAMED rather than mended.
 *
 * A predicate that does not parse produces no verdict at all, which is the worst of the three
 * possible outcomes, and "could not parse: {kind:signal…}" sent the reader to look at Reticle.
 */

import { describe, expect, it } from 'vitest';
import { parseVerifySuffix } from './cli-parse-verify.js';

const verify = (value: string): ReturnType<typeof parseVerifySuffix> =>
  parseVerifySuffix(['http://localhost:3000', '--expect', value], 4400);

const PREDICATE = '{"kind":"signal","name":"order:placed"}';

describe('--expect quoting', () => {
  it('parses the ordinary POSIX form', () => {
    const parsed = verify(PREDICATE);
    expect(parsed.kind).toBe('ok');
    if ('ok' !== parsed.kind) return;
    expect(parsed.expect).toEqual({ kind: 'signal', name: 'order:placed' });
  });

  // cmd.exe: `'` is an ordinary character, so the quotes the docs show arrive as part of the value.
  it('undoes the literal single quotes cmd.exe leaves behind', () => {
    const parsed = verify(`'${PREDICATE}'`);
    expect(parsed.kind).toBe('ok');
    if ('ok' !== parsed.kind) return;
    expect(parsed.expect).toEqual({ kind: 'signal', name: 'order:placed' });
  });

  it('does not strip a lone leading quote, which is a different mistake', () => {
    expect(verify(`'${PREDICATE}`).kind).toBe('error');
  });

  // PowerShell → native exe: the inner double quotes are gone and the value is no longer JSON.
  it('names PowerShell quote-stripping instead of blaming the predicate', () => {
    const parsed = verify('{kind:signal,name:order:placed}');
    expect(parsed.kind).toBe('error');
    if ('error' !== parsed.kind) return;
    expect(parsed.message).toContain('--expect-file');
  });

  it('still reports ordinary malformed JSON as malformed JSON', () => {
    const parsed = verify('{"kind":"signal",');
    expect(parsed.kind).toBe('error');
    if ('error' !== parsed.kind) return;
    expect(parsed.message).toContain('JSON predicate');
  });
});

describe('--expect-file, the form with no quoting at all', () => {
  it('is accepted and carries the path', () => {
    const parsed = parseVerifySuffix(
      ['http://localhost:3000', '--expect-file', 'check.json'],
      4400,
    );
    expect(parsed.kind).toBe('ok');
    if ('ok' !== parsed.kind) return;
    expect(parsed.expectFile).toBe('check.json');
  });

  it('refuses both at once rather than silently preferring one', () => {
    const parsed = parseVerifySuffix(
      ['http://localhost:3000', '--expect', PREDICATE, '--expect-file', 'check.json'],
      4400,
    );
    expect(parsed.kind).toBe('error');
  });
});
