import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every normative sentence can be cited, and a citation never changes what it points at.
 *
 * WHY. An audit of this specification found roughly ninety normative statements and not one that
 * could be named. Section numbers were the only handle, and they had already collided: the document
 * contains a section `11a`, inserted between 11 and 12, which is what happens to numbering that has
 * to stay contiguous. Without stable identifiers a conformance test cannot say which rule it tests,
 * an erratum cannot name the sentence it corrects, and two people can argue for an hour before
 * discovering they were talking about different requirements.
 *
 * WHAT THIS PINS. Uniqueness, and that every normative sentence has one. It deliberately does NOT
 * pin the total, because the count moves whenever a requirement is added, and a guard that has to be
 * edited on every legitimate change is a guard people learn to edit without reading.
 *
 * PERMANENCE is the property this cannot check and the document states instead: a reworded
 * requirement keeps its identifier, a removed one leaves its number retired and never reissued. A
 * test cannot see a renumbering that happens in one commit, so that rule lives in section 1 where a
 * person reviewing a diff will read it.
 */
const SPEC = readFileSync(join(import.meta.dirname, '..', 'SPEC.md'), 'utf8');

/** All-caps only, per RFC 8174: a lower-case "may" states nothing and needs no identifier. */
const NORMATIVE =
  /\b(MUST NOT|MUST|SHALL NOT|SHALL|SHOULD NOT|SHOULD|REQUIRED|RECOMMENDED|MAY|OPTIONAL)\b/;
const ID = /\[OVP-[A-Z]+-\d+\]/;

/** The paragraph defining the keywords uses them as examples and states no requirement itself. */
const isDefinition = (line: string): boolean =>
  line.includes('BCP 14') || line.includes('OVP-CHAN-2`');

function normativeLines(): string[] {
  return SPEC.split('\n').filter(
    (line) =>
      NORMATIVE.test(line) &&
      line.trim().length > 0 &&
      !line.startsWith('|') &&
      !isDefinition(line),
  );
}

describe('requirement identifiers', () => {
  it('finds normative statements at all, so a pass is not a pass over nothing', () => {
    expect(normativeLines().length).toBeGreaterThan(30);
  });

  it('gives every normative statement one', () => {
    const naked = normativeLines()
      .filter((line) => !ID.test(line))
      .map((line) => line.slice(0, 100));
    expect(
      naked,
      'these state a requirement in capitals and cannot be cited. Give each the next number in ' +
        'its area, and never reuse a retired one.',
    ).toEqual([]);
  });

  it('never issues the same identifier twice', () => {
    // A duplicate is worse than a missing one: two rules answer to a single citation, and a
    // conformance report naming it is ambiguous in a way nobody notices.
    const ids = [...SPEC.matchAll(/\[(OVP-[A-Z]+-\d+)\]/g)].map((m) => m[1] ?? '');
    const seen = new Set<string>();
    const duplicated = ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
    expect(duplicated).toEqual([]);
  });

  it('numbers each area from 1 with no gaps, so a missing number means a retired rule', () => {
    /*
     * A gap is meaningful: it says a requirement was removed and its number retired. That is only
     * legible if gaps are otherwise impossible, so the moment this goes red the question to ask is
     * whether a rule was deleted on purpose, and if so, to record it in CHANGELOG.md.
     */
    const byArea = new Map<string, number[]>();
    for (const match of SPEC.matchAll(/\[(OVP-([A-Z]+)-(\d+))\]/g)) {
      const area = match[2] ?? '';
      byArea.set(area, [...(byArea.get(area) ?? []), Number(match[3])]);
    }
    const broken: string[] = [];
    for (const [area, numbers] of byArea) {
      const sorted = [...numbers].sort((a, b) => a - b);
      sorted.forEach((value, index) => {
        if (value !== index + 1) broken.push(`OVP-${area}: expected ${index + 1}, found ${value}`);
      });
    }
    expect(broken).toEqual([]);
  });
});
