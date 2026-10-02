import { describe, expect, it } from 'vitest';
import { windowsShellArg } from './windows-quote.js';

/**
 * Windows argument quoting, tested on every platform because the bug only exists on one.
 *
 * The escaping lived inside a `process.platform` branch, so on a mac or in CI's Linux job the
 * Windows path could not be exercised at all — which is how it stayed wrong. Pulling the rule out
 * as a pure function is most of the fix: it can now be asserted anywhere.
 *
 * CodeQL `js/incomplete-sanitization` (high) on the original, and it flagged the smaller half.
 */
describe('windowsShellArg', () => {
  it('leaves an ordinary argument untouched — quoting everything would be its own bug', () => {
    expect(windowsShellArg('install')).toBe('install');
    expect(windowsShellArg('@reticlehq/browser')).toBe('@reticlehq/browser');
  });

  it('quotes a path containing a space', () => {
    expect(windowsShellArg('C:\\Users\\ada\\My Projects')).toBe('"C:\\Users\\ada\\My Projects"');
  });

  it('a path ending in a backslash does not swallow its own closing quote', () => {
    // The reported bug. `"C:\Users\ada\My Projects\"` reads the trailing \" as an ESCAPED quote, so
    // the quoted region never closes and everything after it is re-parsed by cmd.exe.
    const quoted = windowsShellArg('C:\\Users\\ada\\My Projects\\');
    expect(quoted).toBe('"C:\\Users\\ada\\My Projects\\\\"');
    expect(quoted.endsWith('\\\\"'), 'the final backslash must be doubled').toBe(true);
  });

  it('escapes an interior quote and the backslashes in front of it', () => {
    expect(windowsShellArg('a\\"b')).toBe('"a\\\\\\"b"');
  });

  it('quotes a cmd metacharacter even with no whitespace — the second injection route', () => {
    // Not in the report. The old predicate was /[\s"]/, so `foo&whoami` contains neither a space
    // nor a quote and was handed to cmd.exe RAW. Correct backslash escaping does nothing for this.
    for (const arg of ['foo&whoami', 'a|b', 'a>b', 'a<b', 'a^b', 'a(b', 'a)b']) {
      expect(windowsShellArg(arg), arg).toBe(`"${arg}"`);
    }
  });

  it('quotes the empty string, which would otherwise vanish from the argv', () => {
    expect(windowsShellArg('')).toBe('""');
  });

  it('round-trips through CommandLineToArgvW rules for the cases that matter', () => {
    // Decoding half of the Windows rule, so the encoder is checked against something other than
    // itself: 2n backslashes + `"` → n backslashes and the quote is a delimiter; 2n+1 → n
    // backslashes and a literal quote.
    for (const original of [
      'plain',
      'with space',
      'C:\\dir\\',
      'C:\\dir with space\\',
      'quote"inside',
      'back\\\\slashes',
      'trailing\\\\',
      '',
    ]) {
      expect(decodeArgv(windowsShellArg(original)), original).toBe(original);
    }
  });
});

/** Minimal CommandLineToArgvW decoder for a SINGLE encoded argument. */
function decodeArgv(encoded: string): string {
  let out = '';
  let inQuotes = false;
  let backslashes = 0;
  const flush = (literalQuote: boolean): void => {
    out += '\\'.repeat(Math.floor(backslashes / 2));
    if (0 !== backslashes % 2 && literalQuote) out += '"';
    backslashes = 0;
  };
  for (const ch of encoded) {
    if ('\\' === ch) {
      backslashes += 1;
      continue;
    }
    if ('"' === ch) {
      const odd = 0 !== backslashes % 2;
      flush(true);
      if (!odd) inQuotes = !inQuotes;
      continue;
    }
    out += '\\'.repeat(backslashes);
    backslashes = 0;
    out += ch;
  }
  out += '\\'.repeat(backslashes);
  void inQuotes;
  return out;
}
