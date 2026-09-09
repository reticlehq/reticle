import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * How much an agent has to read before it can do anything.
 *
 * SKILL.md is the first thing an agent loads, every session, before its first action. Its length is
 * therefore a real cost paid by every user, and nothing measured it. Meanwhile the number that
 * matters to a person is a stopwatch: onboarding was measured in the field at nearly eighteen
 * minutes to a first result, against a target of two.
 *
 * This file cannot measure minutes. It measures the thing under our control that feeds them, and
 * pins it so it cannot quietly grow while the real fix is planned.
 *
 * The structural point is the second test. The file covers two unrelated situations in one
 * document: setting Reticle up, and using it once it is set up. Setting up happens once. Using it
 * happens every session afterwards. So the common case reads the whole file to reach the half that
 * applies to it, and pays for the other half forever.
 *
 * The file already knows this. It has a "Which path am I on" section, and that section sits eighty
 * lines after the reader started, which is the whole problem in one sentence. Splitting by
 * situation is the fix; these numbers are how anyone will know whether the split actually worked.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const SKILL = readFileSync(join(REPO_ROOT, 'SKILL.md'), 'utf8');

/**
 * The size ratchet, in bytes.
 *
 * MEASURED 2026-09-10: 274 lines, 3,308 words, 19,918 bytes. The budget is that plus about 1.5%:
 * room to fix a typo, none to add a section.
 *
 * Going over is not forbidden, it is a DECISION. Move the number and write the reason here, the way
 * the tool-surface ratchet does. Coming in well under, move it down and keep the win.
 */
const SKILL_BYTE_BUDGET = 20_200;

/** Where the file stops being general advice and starts being about one situation or the other. */
const SETUP_HEADING = '\n# SETUP\n';
const VERIFY_HEADING = '\n# VERIFY\n';

const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8');

describe('the skill file is a cost every session pays', () => {
  it('has not grown past its budget', () => {
    // A budget alone would pass on an empty file, which is how a broken read looks like a saving.
    expect(bytesOf(SKILL), 'SKILL.md read as empty or near-empty').toBeGreaterThan(5_000);
    expect(
      bytesOf(SKILL),
      `SKILL.md is ${String(bytesOf(SKILL))} B, budget ${String(SKILL_BYTE_BUDGET)} B. Every agent ` +
        'reads this before its first action, every session. Shorten something, or raise the budget ' +
        'deliberately and write the reason next to it.',
    ).toBeLessThanOrEqual(SKILL_BYTE_BUDGET);
  });

  it('records how much an already-installed agent reads but does not need', () => {
    const setupAt = SKILL.indexOf(SETUP_HEADING);
    const verifyAt = SKILL.indexOf(VERIFY_HEADING);
    expect(setupAt, 'SKILL.md has no SETUP section — this test needs updating').toBeGreaterThan(0);
    expect(verifyAt, 'SKILL.md has no VERIFY section — this test needs updating').toBeGreaterThan(
      setupAt,
    );

    const setupHalf = bytesOf(SKILL.slice(setupAt, verifyAt));
    const wastedShare = setupHalf / bytesOf(SKILL);

    // Measured 2026-09-10: preamble 6,100 B, setup half 7,896 B, verify half 5,922 B.
    //
    // So an agent that is already set up reads 19,918 B to use 12,022 B of it. It pays 39.6% for
    // instructions about a job it finished once, weeks ago.
    //
    // Worth saying plainly, because it changes what the fix is: splitting this file by situation
    // cuts the common case by about 40% WITHOUT DELETING A SINGLE WORD. The problem is not that too
    // much was written; it is that two audiences share one document.
    //
    // This bound is a marker, not a claim that 39.6% is acceptable. When the split lands the number
    // drops sharply, and this is how anyone will see that it did.
    expect(
      wastedShare,
      `the setup half is ${String(Math.round(wastedShare * 100))}% of SKILL.md (${String(setupHalf)} B). ` +
        'An agent that is already set up reads all of it for nothing. If you have split the file by ' +
        'situation, this number should have dropped sharply — update the bound and keep the win.',
    ).toBeLessThanOrEqual(0.45);
  });
});
