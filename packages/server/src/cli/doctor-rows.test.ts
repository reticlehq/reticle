import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DOCTOR_ROW_LABELS, DoctorRow, LABEL_COLUMN, doctorRow } from './doctor-rows.js';

/**
 * The guard for #340: `doctor`'s row vocabulary and the docs pages that reproduce its output must
 * describe the same command, in both directions.
 *
 * The direction that actually bites is docs-missing-a-row. A row gets added to the checklist, the
 * pages go on showing the old output, and a user hits a line nobody told them about on the one
 * command they run when they are already stuck. Nothing here was catching that: the labels were
 * free strings across three modules and the pages were prose.
 *
 * The reverse direction matters less often but is worse when it happens — a page showing a row the
 * command cannot print sends someone hunting for output they will never see.
 *
 * Both expectations are derived from `DOCTOR_ROW_LABELS` rather than from a list kept here, so
 * adding a row to the command is what updates the test's expectation. A hardcoded list would only
 * catch the direction that does not bite.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** The reference table of rows. This is the page that promises to list every line. */
const ROW_TABLE_PAGE = join(REPO_ROOT, 'docs', 'cli', 'doctor.mdx');

/** Every page that reproduces `doctor` output in a sample block. */
const SAMPLE_PAGES = [
  join(REPO_ROOT, 'docs', 'cli', 'doctor.mdx'),
  join(REPO_ROOT, 'docs', 'cli.mdx'),
  join(REPO_ROOT, 'docs', 'troubleshooting.mdx'),
];

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * Row labels appearing in fenced blocks that show `reticle doctor` output.
 *
 * Scoped to those blocks deliberately: the pages contain plenty of other indented output, and a
 * guard that scanned every fence would fail on unrelated samples and get deleted.
 */
function labelsInSampleBlocks(markdown: string): string[] {
  const found: string[] = [];
  const blocks = markdown.split('```');
  for (let index = 1; index < blocks.length; index += 2) {
    const block = blocks[index];
    if (undefined === block || !block.includes('reticle doctor')) continue;
    for (const line of block.split('\n')) {
      // A row is two spaces, the label, then at least two spaces before its value. The lazy
      // quantifier stops the label swallowing the padding.
      const match = /^ {2}([a-z][a-z ]*?) {2,}\S/.exec(line);
      const label = match?.[1];
      if (undefined !== label) found.push(label);
    }
  }
  return found;
}

describe('the doctor row column', () => {
  it('pads to the width the hand-written rows used', () => {
    // 13 is what every call site padded to before these became a constant. Pinning it means a
    // change to the column is deliberate and visible in a diff, rather than an invisible reflow
    // of every sample block in the docs.
    expect(LABEL_COLUMN).toBe(13);
  });

  it('builds a row the docs samples would recognise', () => {
    expect(doctorRow(DoctorRow.NODE, 'v22.0.0')).toBe('  node         v22.0.0');
    // The longest label still gets its two spaces, which is what makes the column hold.
    expect(doctorRow(DoctorRow.BRIDGE_PORT, '4400')).toBe('  bridge port  4400');
  });

  it('has no duplicate labels', () => {
    expect(new Set(DOCTOR_ROW_LABELS).size).toBe(DOCTOR_ROW_LABELS.length);
  });
});

describe('every row doctor can print is documented (#340)', () => {
  const table = read(ROW_TABLE_PAGE);

  it.each([...DOCTOR_ROW_LABELS])('documents the `%s` row', (label) => {
    // Backticked, as the table writes them. A bare substring match would let `daemon` satisfy the
    // requirement for `daemon log`, which is the failure this guard is supposed to notice.
    expect(table).toContain(`\`${label}\``);
  });

  it('covers the CONDITIONAL rows too, which are the ones a reader has never seen', () => {
    // `version`, `port check`, `sibling` and `desktop` print only on skew, on a port mismatch, on a
    // sibling listener, and on a desktop project. They are the rows least likely to be recognised
    // and most likely to be missed by a guard built from one run's output — so they are named
    // explicitly here.
    for (const label of [
      DoctorRow.VERSION,
      DoctorRow.PORT_CHECK,
      DoctorRow.SIBLING,
      DoctorRow.DESKTOP,
    ]) {
      expect(table).toContain(`\`${label}\``);
    }
  });
});

describe('every row the docs show is one doctor can print (#340)', () => {
  it.each(SAMPLE_PAGES)('%s shows no invented rows', (page) => {
    const labels = labelsInSampleBlocks(read(page));
    // A page with no doctor sample is fine; a page with one that shows nothing is not — that would
    // mean the extractor stopped matching and this half of the guard silently passes forever.
    const known = new Set<string>(DOCTOR_ROW_LABELS);
    for (const label of labels) {
      expect(known, `${page} shows a row \`${label}\` that doctor cannot print`).toContain(label);
    }
  });

  it('actually extracts rows, so a passing guard means something', () => {
    // The control. If the sample blocks stop being recognised, every assertion above passes
    // vacuously — the same "gate that checks nothing" shape #340 is about.
    const total = SAMPLE_PAGES.reduce(
      (count, page) => count + labelsInSampleBlocks(read(page)).length,
      0,
    );
    expect(total).toBeGreaterThan(0);
  });
});
