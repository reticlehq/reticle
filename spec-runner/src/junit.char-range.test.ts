import { describe, expect, it } from 'vitest';
import { TestStatus } from './constants.js';
import { toJUnitXml } from './junit.js';
import type { SpecResult } from './types.js';

/**
 * The JUnit report is the only thing CI reads, so a document a parser refuses is the same outcome as
 * no report: the failure is invisible and the run looks empty. `stripXmlIllegal` exists for exactly
 * that, and it enforced only the LOWER bound of XML 1.0's `Char` production
 * (`#x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]`), leaving its two upper
 * holes open.
 *
 * U+FFFF is the one that actually breaks a parser: fed a `<testcase name="...">` carrying it, saxes
 * stops with "disallowed character". Surrogates are the milder half, since writing the file as UTF-8
 * turns a lone one into U+FFFD, but they are illegal by the same clause.
 */
const passing = (name: string): SpecResult => ({
  name,
  status: TestStatus.PASS,
  durationMs: 1,
});

const ILLEGAL: ReadonlyArray<readonly [string, string]> = [
  ['U+FFFF noncharacter', '\uffff'],
  ['U+FFFE noncharacter', '\ufffe'],
  ['a lone high surrogate', '\ud800'],
  ['a lone low surrogate', '\udc00'],
  ['an ANSI escape', '\u001b'],
  ['a NUL', '\u0000'],
];

describe('toJUnitXml drops every character XML 1.0 forbids', () => {
  for (const [label, ch] of ILLEGAL) {
    it(`drops ${label}`, () => {
      const xml = toJUnitXml([passing(`login ${ch} flow`)]);
      expect(xml).not.toContain(ch);
      // The rest of the name has to survive: this is a strip, not a rejection.
      expect(xml).toContain('login');
      expect(xml).toContain('flow');
    });
  }
});

describe('it keeps everything XML 1.0 allows', () => {
  const LEGAL: ReadonlyArray<readonly [string, string]> = [
    ['tab', '\t'],
    ['newline', '\n'],
    ['carriage return', '\r'],
    ['U+FFFD, the last legal BMP code point', '\ufffd'],
    ['an astral emoji', '\u{1f600}'],
    ['a valid surrogate PAIR, which is one astral code point', '\ud83d\ude00'],
  ];

  for (const [label, ch] of LEGAL) {
    it(`keeps ${label}`, () => {
      expect(toJUnitXml([passing(`login ${ch} flow`)])).toContain(ch);
    });
  }

  it('still escapes the five XML-significant characters', () => {
    const xml = toJUnitXml([passing(`a & b < c > d " e ' f`)]);
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&lt;');
    expect(xml).toContain('&gt;');
    expect(xml).toContain('&quot;');
    expect(xml).toContain('&apos;');
  });
});
