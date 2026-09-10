import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTRACT_FINGERPRINT } from './contract-fingerprint.js';
import { execFileSync } from 'node:child_process';

/**
 * The wire contract cannot change without somebody writing down what changed.
 *
 * The fingerprint already tells the two halves of Reticle whether they agree. What it cannot tell
 * anyone is WHAT is different, and that is the question asked by the people this matters most to:
 * whoever maintains a program that talks to Reticle from outside this repository. "The contract
 * moved" is not something they can act on.
 *
 * So `core/CHANGES.md` records it, and this keeps the two in step. Change the contract and the
 * fingerprint moves on its own, this goes red, and the way to make it green is to write the sentence.
 * A change log that is allowed to fall behind is worse than none, because it is read as current.
 */

// Asked rather than counted. A walk of `..` segments up to the repository is a statement about how
// deeply this package sits, not about the repository, and this package has just moved.
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: import.meta.dirname,
  encoding: 'utf8',
}).trim();
const CHANGES_FILE = join(REPO_ROOT, 'core', 'CHANGES.md');

/** Fingerprints listed in the history table, newest first. */
function recordedFingerprints(): string[] {
  const text = readFileSync(CHANGES_FILE, 'utf8');
  const history = text.slice(text.indexOf('## History'));
  return [...history.matchAll(/^\|\s*`([0-9a-f]{8})`\s*\|/gm)].map((m) => m[1] ?? '');
}

describe('core/CHANGES.md keeps up with the wire contract', () => {
  it('has a history to read', () => {
    // Without this, a table that stopped parsing would make the check below pass on an empty list.
    expect(recordedFingerprints().length).toBeGreaterThan(0);
  });

  it('the newest entry describes the contract as it is now', () => {
    expect(
      recordedFingerprints()[0],
      'The wire contract changed and core/CHANGES.md was not updated. Add a row at the TOP of ' +
        `its history table with the fingerprint ${CONTRACT_FINGERPRINT}, today's date, and one ` +
        'sentence saying what changed, written for somebody maintaining a program that talks to ' +
        'Reticle and cannot see this repository.',
    ).toBe(CONTRACT_FINGERPRINT);
  });

  it('no fingerprint is recorded twice', () => {
    // Two rows with the same code means one of them describes a change that did not happen.
    const recorded = recordedFingerprints();
    expect(new Set(recorded).size).toBe(recorded.length);
  });

  it('every entry says something about what changed', () => {
    const text = readFileSync(CHANGES_FILE, 'utf8');
    const rows = [...text.matchAll(/^\|\s*`[0-9a-f]{8}`\s*\|([^|]*)\|([^|]*)\|/gm)];
    expect(rows.length).toBe(recordedFingerprints().length);
    for (const row of rows) {
      expect((row[1] ?? '').trim()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // A row with a date and no sentence is the shape this file exists to prevent.
      expect((row[2] ?? '').trim().length).toBeGreaterThan(20);
    }
  });
});
