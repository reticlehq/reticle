/**
 * Rule: no-runaway-comment.
 *
 * Caps a single block comment's length.
 *
 * Incident: commit `ab26e749` authored a doc comment through an unquoted heredoc, so the shell
 * evaluated the backticked code spans inside it. `git ls-files` expanded into the file, pasting 407
 * lines of a private repository's layout — a prod CA cert path, a licence-keypair script, a deploy
 * secrets template — into `server/src/language/flows/flows.ts`, and deleting every other code span
 * the comment named. It compiled, it typechecked, it passed every gate, and it reached the published
 * tarball because `dist` retains comments.
 *
 * The cap is the cheapest check that catches it: the accident was 423 lines and the longest genuine
 * comment in the repository is 45, so nothing legitimate is near the limit.
 */

import { AST_TOKEN_TYPES, ESLintUtils } from '@typescript-eslint/utils';
import { DOCS_URL_ROOT, MAX_COMMENT_LINES, RUNAWAY_COMMENT_MESSAGE } from './constants.js';

const createRule = ESLintUtils.RuleCreator((name) => `${DOCS_URL_ROOT}#${name}`);

export const noRunawayComment = createRule({
  name: 'no-runaway-comment',
  meta: {
    type: 'problem',
    docs: { description: 'Cap the length of a single block comment.' },
    schema: [],
    messages: { runawayComment: RUNAWAY_COMMENT_MESSAGE },
  },
  defaultOptions: [],
  create(context) {
    return {
      Program(): void {
        for (const comment of context.sourceCode.getAllComments()) {
          if (AST_TOKEN_TYPES.Block !== comment.type) continue;
          const lines = comment.loc.end.line - comment.loc.start.line + 1;
          if (lines <= MAX_COMMENT_LINES) continue;
          context.report({
            loc: comment.loc,
            messageId: 'runawayComment',
            data: { lines: String(lines), max: String(MAX_COMMENT_LINES) },
          });
        }
      },
    };
  },
});
