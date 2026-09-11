/**
 * Rule: no-internal-tags.
 *
 * Bans design-doc reference codes and internal version strings from comments, TEST DESCRIPTIONS and
 * the FILE AND DIRECTORY NAMES of the module itself, so a reader of the source never meets a token
 * that only means something in a document they cannot see.
 *
 * Those four surfaces are the ones the project rule names, and the rule enforced two of them. A path
 * is the first thing a reader meets, before any comment, so `n5-ring-buffer.ts` is the shape this
 * exists to prevent stated in the loudest available place.
 *
 * This rule exists because the prose version of it did not hold. An audit of the codebase found the
 * machine-checked rules at ~100% compliance and every prose-only rule violated — 59 tracking codes
 * across the library packages alone, including in the contract package and in test descriptions, plus
 * codes that leaked into user-facing docs. The gap was enforcement, not intent, so the rule is now a
 * lint error rather than a paragraph.
 *
 * Deliberately narrow, to avoid punishing legitimate prose:
 *   - a bare `W11`, `B37`, `N5`, `M8` style token (one or two capitals + digits) standing alone;
 *   - a section reference like `§4.3`;
 *   - an internal version string like `v2.2.0`.
 * Ordinary technical prose that happens to contain a letter and digits inside a larger word (`UTF-8`,
 * `H2`, `Welford M2` when part of a sentence) is matched only when it stands alone as a tag.
 */

import { relative, sep } from 'node:path';
import { AST_NODE_TYPES, ESLintUtils } from '@typescript-eslint/utils';
import { DOCS_URL_ROOT } from './constants.js';

const createRule = ESLintUtils.RuleCreator((name) => `${DOCS_URL_ROOT}#${name}`);

const INTERNAL_TAG_MESSAGE =
  "Internal reference '{{tag}}' does not belong in source. It means nothing to a reader without the design doc — describe the behaviour instead.";
const PATH_TAG_MESSAGE =
  "Internal reference '{{tag}}' does not belong in a file or directory name. It means nothing to a reader without the design doc — name the module after what it does.";

/** `(W11)`, `B37`, `W10.3`, `N5:` — a short capital-prefixed code used as a label. */
const TRACKING_CODE = /(?<![A-Za-z0-9])[A-Z]{1,2}\d{1,2}(?:\.\d{1,2})?(?![A-Za-z0-9])/g;
/**
 * `§4.3` — a design-doc section reference.
 *
 * Defaults to FLAGGING and exempts only a citation of a NAMED EXTERNAL spec. The first version did the
 * reverse — it exempted any § preceded by a word — which silently permitted `see PLAN §4.3`, the very
 * shape being banned. For a ban rule the default must be "flag", or the exemption swallows the rule.
 */
const SECTION_REF = /§\s?\d+(?:\.\d+)*/g;
/** Specs whose section numbers are real references a reader can follow. */
const EXTERNAL_SPECS =
  /\b(RFC|WCAG|ECMA|ISO|IEEE|W3C|WHATWG|HTML|CSS|ARIA|HTTP|OAuth|JSON-LD)\b[^§]{0,20}$/i;
/**
 * `v2.2.0` — an INTERNAL version string.
 *
 * Same inversion: flag by default, exempt only a version attributed to a NAMED third party. Exempting
 * "any capitalised preceding word" permitted `new in Reticle v2.2.0` — our own product name made the
 * banned string legal.
 */
const VERSION_STRING = /(?<![A-Za-z0-9])v\d+\.\d+\.\d+(?![A-Za-z0-9])/g;
/**
 * The same two shapes over a PATH, case-insensitively.
 *
 * File names here are kebab-case, so a code that would read `N5` in a sentence reads `n5` in a path
 * and the upper-case patterns above cannot see it. The boundaries do the work that case was doing:
 * `e2e`, `utf8`, `http2` and `base64` all fail them, because each needs a non-alphanumeric on both
 * sides of a letters-then-digits token.
 */
const PATH_TRACKING_CODE = /(?<![A-Za-z0-9])[A-Za-z]{1,2}\d{1,2}(?:\.\d{1,2})?(?![A-Za-z0-9])/g;
const PATH_VERSION_STRING = /(?<![A-Za-z0-9])v\d+\.\d+\.\d+(?![A-Za-z0-9])/gi;
/** Third-party names whose versions are legitimate prose. Reticle is deliberately NOT here. */
const THIRD_PARTY =
  /\b(React|Vite|Node|TypeScript|Playwright|Chrome|Chromium|Firefox|Safari|Zod|Vitest|ESLint|pnpm|MCP)\b[^v]{0,12}$/i;

/** Tokens that look like codes but are established technical terms. */
/** Test-block callees whose first argument is a human-readable description. */
const TEST_BLOCKS = new Set(['describe', 'it', 'test', 'suite', 'bench']);

/**
 * Tokens matching the code shape that are established technical terms. Kept deliberately explicit: a
 * rule that fires on ordinary technical writing gets disabled, and a disabled rule enforces nothing.
 */
const ALLOWED = new Set([
  'M2', // Welford's streaming-variance accumulator
  'H1',
  'H2',
  'H3', // heading levels
  'P1',
  'P2',
  'P3', // priority labels
  'S3',
  'EC2', // AWS services
  'ES5',
  'ES6', // ECMAScript editions
  'IE11', // browser
  'Q1',
  'Q2',
  'Q3',
  'Q4', // quarters
  'L1',
  'L2', // cache levels
  // The JavaScript engine. Omitting it made the rule fire on ordinary writing about heap growth and
  // GC in a JavaScript codebase — the most likely place this rule runs, and the fastest way to get it
  // switched off. Found by running the rule over directories the linter had never reached.
  'V8',
  'H4',
  'H5',
  'H6', // heading levels — H1-H3 were already here; stopping at 3 was an oversight, not a rule
]);

export const noInternalTags = createRule({
  name: 'no-internal-tags',
  meta: {
    type: 'problem',
    docs: { description: 'Ban design-doc codes and internal version strings from comments.' },
    schema: [],
    messages: { internalTag: INTERNAL_TAG_MESSAGE, pathTag: PATH_TAG_MESSAGE },
  },
  defaultOptions: [],
  create(context) {
    /** Every banned token in a piece of text. */
    const tagsIn = (text: string): Set<string> => {
      const found = new Set<string>();
      for (const { pattern, exempt } of [
        { pattern: TRACKING_CODE, exempt: undefined },
        { pattern: SECTION_REF, exempt: EXTERNAL_SPECS },
        { pattern: VERSION_STRING, exempt: THIRD_PARTY },
      ]) {
        pattern.lastIndex = 0;
        for (const match of text.matchAll(pattern)) {
          const tag = match[0].trim();
          if (ALLOWED.has(tag.replace(/[^A-Za-z0-9]/g, ''))) continue;
          // Attribution is judged from the text BEFORE the match, so "RFC 6265 §5.2" is a reference
          // and "PLAN §4.3" is a design-doc pointer.
          if (exempt !== undefined && exempt.test(text.slice(0, match.index ?? 0))) continue;
          found.add(tag);
        }
      }
      return found;
    };

    /**
     * Banned tokens in this module's own path, relative to the project root.
     *
     * Relative, never absolute: an absolute path runs through directories nobody chose as part of
     * this codebase (a CI runner's workspace, a developer's home) and flagging those would report a
     * violation the author cannot fix.
     */
    const pathTags = (): Set<string> => {
      const found = new Set<string>();
      const filename = context.filename;
      // `<input>` and `<text>` are what a linter reports for source with no file, e.g. a RuleTester
      // case or a piped snippet. There is no path to judge.
      if (filename.startsWith('<')) return found;
      const rel = relative(context.cwd, filename);
      // Outside the project root entirely: `relative` climbs out with `..`, and the segments above
      // the root are not this codebase's to answer for.
      if (rel.startsWith('..')) return found;
      const path = rel.split(sep).join('/');
      // Version FIRST, and its spans claimed, because the tracking-code shape is a prefix of it:
      // `replay-v2.2.0.ts` matches `v2.2.0` as a version and `v2.2` as a code, and reporting both
      // would name the same offence twice under two different explanations.
      const claimed: { start: number; end: number }[] = [];
      for (const pattern of [PATH_VERSION_STRING, PATH_TRACKING_CODE]) {
        pattern.lastIndex = 0;
        for (const match of path.matchAll(pattern)) {
          const start = match.index ?? 0;
          const end = start + match[0].length;
          if (claimed.some((c) => start < c.end && end > c.start)) continue;
          const tag = match[0].trim();
          claimed.push({ start, end });
          if (ALLOWED.has(tag.replace(/[^A-Za-z0-9]/g, '').toUpperCase())) continue;
          found.add(tag);
        }
      }
      return found;
    };

    return {
      Program(node): void {
        for (const comment of context.sourceCode.getAllComments()) {
          for (const tag of tagsIn(comment.value)) {
            context.report({ node: comment, messageId: 'internalTag', data: { tag } });
          }
        }
        // Reported on the Program node: the offence is the module's name, which has no node of its
        // own, and the first line is where a reader will look for it.
        for (const tag of pathTags()) {
          context.report({ node, messageId: 'pathTag', data: { tag } });
        }
      },

      /**
       * TEST DESCRIPTIONS are string literals, not comments, so a comment-only rule could not see them
       * — and the project rule names them explicitly. Seven violations survived a repo-wide cleanup that
       * claimed to have removed them, precisely because nothing mechanical was looking here.
       */
      CallExpression(node): void {
        const callee = node.callee;
        const name =
          callee.type === AST_NODE_TYPES.Identifier
            ? callee.name
            : callee.type === AST_NODE_TYPES.MemberExpression &&
                callee.object.type === AST_NODE_TYPES.Identifier
              ? callee.object.name
              : undefined;
        if (name === undefined || !TEST_BLOCKS.has(name)) return;
        const first = node.arguments[0];
        if (first?.type !== AST_NODE_TYPES.Literal || typeof first.value !== 'string') return;
        for (const tag of tagsIn(first.value)) {
          context.report({ node: first, messageId: 'internalTag', data: { tag } });
        }
      },
    };
  },
});
