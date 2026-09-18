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

/**
 * A whole view that rendered is not a message the app said.
 *
 * `appeared` earns its keep on small text: "Invalid credentials" turns a login that reports
 * `ok / settled / mutated` into one that says what went wrong. But an added node's `textContent`
 * flattens its ENTIRE subtree with no separators, so when a navigation swaps a view the field
 * becomes a page dump run together into one unreadable string.
 *
 * Measured on a real drive against the bench app, clicking Compose:
 *
 *   appeared: "Compose | generate a release note | DraftRelease note generatorTitle · commits on
 *              blurWhat shipped?GenerateOutputYour generated note appears here."
 *
 * 146 bytes, 36 tokens, on every navigation verdict, and no reader can act on any of it — note
 * "DraftRelease" and "blurWhat", which are two fragments with the boundary lost. The snapshot
 * already describes the new view properly, which makes dropping this the cheaper mistake, exactly
 * as it is for the bare-numeral case above.
 */

const added = (el: Element): MutationRecord =>
  ({ type: 'childList', addedNodes: [el], target: document.body }) as unknown as MutationRecord;

const el = (html: string): Element => {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host.firstElementChild ?? host;
};

describe('a rendered view is not something the app said', () => {
  it('drops a container whose subtree is a composed view', () => {
    const view = el(
      '<section><h1>Release note generator</h1><label>Title</label><input/>' +
        '<label>What shipped?</label><button>Generate</button><h2>Output</h2>' +
        '<p>Your generated note appears here.</p></section>',
    );
    const appeared = new AppearedText();
    appeared.collect([added(view)]);
    expect(appeared.effect().appeared).toBeUndefined();
  });

  it('keeps a message, even wrapped in an element', () => {
    // The whole reason the field exists — this must survive the cut.
    const appeared = new AppearedText();
    appeared.collect([added(el('<div class="error">Invalid credentials</div>'))]);
    expect(appeared.effect().appeared).toBe('Invalid credentials');
  });

  it('keeps a message with a little markup inside it', () => {
    const appeared = new AppearedText();
    appeared.collect([added(el('<div>Could not save — <strong>try again</strong></div>'))]);
    expect(appeared.effect().appeared).toContain('Could not save');
  });
});
