import { afterAll, describe, it } from 'vitest';
import { RuleTester } from '@typescript-eslint/rule-tester';
import { noRunawayComment } from './no-runaway-comment.js';
import { MAX_COMMENT_LINES } from './constants.js';

RuleTester.afterAll = afterAll;
RuleTester.it = it;
RuleTester.itOnly = it.only;
RuleTester.describe = describe;

const ruleTester = new RuleTester();

/** A block comment of exactly `lines` lines, including its delimiters. */
const block = (lines: number): string =>
  ['/**', ...Array.from({ length: lines - 2 }, (_, i) => ` * line ${String(i)}`), ' */'].join('\n');

/**
 * The invalid case is the shape that shipped: a doc comment authored through an unquoted heredoc,
 * into which the shell pasted a repository listing. The valid cases are the longest genuine comments
 * in this repository, which must not be punished — a rule that fires on real prose gets disabled.
 */
ruleTester.run('no-runaway-comment', noRunawayComment, {
  valid: [
    { code: '/** one line */' },
    { code: block(MAX_COMMENT_LINES) },
    { code: '// a long line comment is not a block comment and is not capped' },
    // Many separate blocks, none over the cap: length is per comment, never per file.
    { code: [block(40), block(40), block(40)].join('\n\n') },
  ],
  invalid: [
    { code: block(MAX_COMMENT_LINES + 1), errors: [{ messageId: 'runawayComment' }] },
    // The accident itself: 423 lines, of which 407 were pasted shell output.
    { code: block(423), errors: [{ messageId: 'runawayComment' }] },
  ],
});
