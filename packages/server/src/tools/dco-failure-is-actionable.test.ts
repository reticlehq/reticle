import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The DCO failure must carry the fix, not a pointer to a document that lacks it.
 *
 * Three of three external contributors have now been blocked by this check (#180, #181, #182). It is
 * the single most common thing standing between a first-time contributor and a merged PR here, and
 * the message they got said:
 *
 *   See https://developercertificate.org and CONTRIBUTING.md.
 *
 * `CONTRIBUTING.md` says nothing about signing off — the word does not appear in it, nor in the PR
 * template. So the error pointed at a document that could not answer it, which is the same defect
 * this codebase keeps fixing elsewhere: a message that sends the reader somewhere useless.
 *
 * The remedy differs by shape and both are needed, which is exactly why prose failed:
 *   - one commit  -> `git commit --amend --no-edit -s`
 *   - several     -> `git rebase --signoff <base>`
 *
 * Pinned here rather than trusted, because a CI message is the one piece of documentation nobody
 * re-reads until it is already failing someone.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const DCO = readFileSync(join(REPO, '.github', 'workflows', 'dco.yml'), 'utf8');

/**
 * Only what the contributor actually SEES — the echoed lines.
 *
 * Grepping the whole file conflates the message with the comments explaining it, and a comment that
 * mentions CONTRIBUTING.md in order to say why we stopped linking to it would fail the last check
 * below. The rule is about the output, so the assertion has to be too.
 */
const EMITTED = DCO.split('\n')
  .filter((line) => /^\s*echo /.test(line))
  .join('\n');

describe('the DCO failure tells a contributor how to fix it', () => {
  it('names the single-commit remedy', () => {
    expect(EMITTED).toContain('--amend');
    expect(EMITTED).toMatch(/--amend[^\n]*-s|commit -s/);
  });

  it('names the multi-commit remedy, which is not the same command', () => {
    // The case every one of the three blocked PRs was actually in: more than one commit, so
    // `--amend` alone signs only the last.
    expect(EMITTED).toContain('--signoff');
    expect(EMITTED).toContain('rebase');
  });

  it('says the push must be forced, since signing rewrites history', () => {
    // Omitting this leaves the contributor with a rejected push and no idea why.
    expect(EMITTED).toContain('force-with-lease');
  });

  it('does not send the reader to a document that does not cover sign-off', () => {
    // If CONTRIBUTING.md ever documents it, this may reference it again — but only then.
    const contributing = readFileSync(join(REPO, 'CONTRIBUTING.md'), 'utf8');
    const documented = /sign[- ]?off|signed-off-by|commit -s/i.test(contributing);
    if (!documented) expect(EMITTED).not.toContain('CONTRIBUTING.md');
  });
});
