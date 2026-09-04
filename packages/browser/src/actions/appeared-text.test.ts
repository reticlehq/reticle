import { describe, expect, it } from 'vitest';
import { AppearedText, HAS_LETTER_FALLBACK } from './appeared-text.js';

describe('HAS_LETTER_FALLBACK: the non-\\p{L} range fallback', () => {
  // Exercised directly: on every engine this suite runs on, `\p{L}` is supported, so
  // `AppearedText` alone never takes this branch and would never prove these ranges work.

  it.each([
    ['Latin', 'hello'],
    ['Greek', 'γειά'],
    ['Cyrillic', 'привет'],
    ['Armenian', 'բարև'],
    ['Hebrew', 'שלום'],
    ['Arabic', 'مرحبا'],
    ['Thai', 'สวัสดี'],
    ['Georgian', 'გამარჯობა'],
    ['Hiragana', 'こんにちは'],
    ['Katakana', 'コンニチハ'],
    ['CJK', '你好'],
    ['Hangul', '안녕하세요'],
  ])('matches %s text', (_script, text) => {
    expect(HAS_LETTER_FALLBACK.test(text)).toBe(true);
  });

  it('matches an astral-plane letter (Deseret, outside every named BMP range)', () => {
    expect(HAS_LETTER_FALLBACK.test('𐐔𐐯𐑅𐐨𐑉𐐯𐐻')).toBe(true);
  });

  it('matches an astral-plane symbol too — the documented over-inclusive trade-off', () => {
    expect(HAS_LETTER_FALLBACK.test('😀')).toBe(true);
  });

  it('does not match a bare digit run', () => {
    expect(HAS_LETTER_FALLBACK.test('409')).toBe(false);
  });

  it('does not match whitespace and punctuation alone', () => {
    expect(HAS_LETTER_FALLBACK.test('— · ')).toBe(false);
  });
});

/** A minimal characterData mutation record — the only shape `collect` reads. */
function charDataRecord(text: string): MutationRecord {
  return {
    type: 'characterData',
    target: { textContent: text, parentElement: null } as unknown as Node,
  } as unknown as MutationRecord;
}

function collected(text: string): string | undefined {
  const at = new AppearedText();
  at.collect([charDataRecord(text)]);
  return at.effect().appeared;
}

describe('AppearedText: end-to-end script coverage (primary \\p{L} path)', () => {
  it('reports Thai text', () => {
    expect(collected('ไม่พบข้อมูล')).toBe('ไม่พบข้อมูล');
  });

  it('reports Georgian text', () => {
    expect(collected('ვერ მოიძებნა')).toBe('ვერ მოიძებნა');
  });

  it('reports an astral-plane letter', () => {
    expect(collected('𐐔𐐯𐑅𐐨𐑉𐐯𐐻')).toBe('𐐔𐐯𐑅𐐨𐑉𐐯𐐻');
  });

  it('still drops a bare digit run with no letters', () => {
    expect(collected('409')).toBeUndefined();
  });
});
