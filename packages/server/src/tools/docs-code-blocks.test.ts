/**
 * Every JSON block in the docs is PARSED, not read.
 *
 * The existing docs guards cover names (a `reticle_*` tool exists), packages (nobody is told to npx
 * something we do not own) and commands (every documented CLI invocation is run through the shipped
 * parser). None of them opens a JSON fence. So a predicate example with a trailing comma, a smart
 * quote picked up from a rewrite, or a brace lost in an edit renders perfectly, reviews cleanly, and
 * fails the moment a reader pastes it — which for this product is worse than usual, because a reader
 * pasting a predicate is the reader doing exactly what the docs asked.
 *
 * JSON is the right thing to check here and TypeScript is not, at least not yet: a JSON fence is
 * either valid or it is not, with no context and no imports, so the check is exact and has no
 * judgement in it. A TS fence is usually a fragment with undeclared identifiers, where "does it
 * parse" needs a policy about what counts as a complete example before it means anything.
 *
 * Deliberate exclusions, each because the fence is not claiming to be parseable JSON:
 *  - `jsonc` / `json5`, which permit comments and are used for client configs that have them.
 *  - a fence whose body is elided with `...` or `…`, which is prose showing a shape.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');

/** Files a reader is expected to copy out of. */
const DOC_ROOTS = ['docs', 'skills'];
const ROOT_DOCS = ['SKILL.md', 'README.md'];

/** A fence whose body is a shape rather than a value — `...` stands in for the parts left out. */
const ELIDED = /(^|\s)(\.\.\.|…)(\s|$)/;

interface Block {
  file: string;
  lang: string;
  body: string;
  line: number;
}

function markdownFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.endsWith('.md')) out.push(full);
    }
  };
  for (const root of DOC_ROOTS) walk(join(REPO, root));
  for (const doc of ROOT_DOCS) out.push(join(REPO, doc));
  return out;
}

function blocksIn(file: string): Block[] {
  const lines = readFileSync(file, 'utf8').split('\n');
  const out: Block[] = [];
  let lang: string | undefined;
  let start = 0;
  let body: string[] = [];
  for (const [i, line] of lines.entries()) {
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (null === fence) {
      if (lang !== undefined) body.push(line);
      continue;
    }
    if (lang === undefined) {
      lang = fence[1] ?? '';
      start = i + 2;
      body = [];
      continue;
    }
    out.push({ file: relative(REPO, file), lang, body: body.join('\n'), line: start });
    lang = undefined;
  }
  return out;
}

const allBlocks = markdownFiles().flatMap(blocksIn);

describe('code blocks a reader is told to copy', () => {
  /**
   * The cardinality check. Every guard that scans a directory can pass over an empty set, and this
   * one would then be a green that means "the walk is broken" rather than "the docs are clean".
   */
  it('actually found blocks to check — a green over zero files proves nothing', () => {
    expect(allBlocks.length).toBeGreaterThan(50);
    expect(new Set(allBlocks.map((b) => b.file)).size).toBeGreaterThan(5);
  });

  it('every JSON block parses', () => {
    const broken: string[] = [];
    for (const block of allBlocks) {
      if (block.lang !== 'json') continue;
      if ('' === block.body.trim() || ELIDED.test(block.body)) continue;
      try {
        JSON.parse(block.body) as unknown;
      } catch (error) {
        broken.push(`${block.file}:${String(block.line)} — ${String(error)}`);
      }
    }
    expect(
      broken,
      `JSON a reader would paste and get an error from:\n${broken.join('\n')}`,
    ).toEqual([]);
  });

  /**
   * Typographic quotes are the specific way this breaks in practice: prose tooling and rewrites turn
   * a straight quote into a curly one inside a fence, and the block still looks right. It is worth
   * its own check because
   * the failure is invisible to the eye and fatal to a paste — and it applies to fences that are not
   * JSON too.
   */
  it('no copyable block contains a smart quote or a non-breaking space', () => {
    const offenders: string[] = [];
    for (const block of allBlocks) {
      if (!['json', 'jsonc', 'ts', 'tsx', 'js', 'javascript', 'bash', 'sh'].includes(block.lang)) {
        continue;
      }
      const bad = /[\u201C\u201D\u2018\u2019\u00A0]/.exec(block.body);
      if (bad !== null) {
        offenders.push(`${block.file}:${String(block.line)} — found ${JSON.stringify(bad[0])}`);
      }
    }
    expect(
      offenders,
      `a smart quote or non-breaking space inside a fence is invisible and fatal to a paste:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  /**
   * A fence that opens and never closes swallows everything after it into the block, so the rest of
   * the page renders as code. `blocksIn` only emits CLOSED fences, so an odd count is the signal.
   */
  it('every fence is closed', () => {
    const unbalanced: string[] = [];
    for (const file of markdownFiles()) {
      const fences = (readFileSync(file, 'utf8').match(/^\s*```/gm) ?? []).length;
      if (fences % 2 !== 0) unbalanced.push(`${relative(REPO, file)} — ${String(fences)} fences`);
    }
    expect(
      unbalanced,
      `an unclosed fence renders the rest of the page as code:\n${unbalanced.join('\n')}`,
    ).toEqual([]);
  });
});
