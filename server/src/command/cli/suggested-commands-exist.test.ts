/**
 * Every `reticle <verb>` we suggest to a human must be a verb we dispatch.
 *
 * I shipped one that was not. The version-skew line in `doctor` told the reader to run
 * `reticle kill` — a PROPOSAL (#114), described accurately as a gap in `docs/system-map.md`, which I
 * read as if it shipped. It reached `main` in #190 before anyone noticed.
 *
 * That failure is not specific to one string. Every one of these messages is written by someone
 * reading the codebase, and the codebase contains proposals, retired verbs, and a second CLI —
 * so "a plausible verb" and "a real verb" are easy to confuse. `doctor`, `status` and the install
 * report are also precisely the surfaces a human reads *while already stuck*, where a command that
 * errors is a second dead end on top of the first.
 *
 * The verb set comes from `knownCommand()` — the parser's own union of local and cloud verbs — not
 * a list copied into this file. A copied list is the same mistake one level up: it would go stale,
 * and a stale allow-list fails green.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { knownCommand } from './cli-parse.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A backticked span that LOOKS like a command line.
 *
 * The closing backtick alone cannot separate advice from prose, because in TypeScript a backtick is
 * also a string delimiter: `` `reticle daemon did not become ready on port ${port}` `` is a template
 * literal, not a suggestion. An earlier draft flagged two of those, and a guard that cries wolf is
 * one people learn to ignore — worse than no guard.
 *
 * So the discriminator is SHAPE: after the verb, a real suggestion contains only command tokens —
 * flags, placeholders, simple paths. Prose brings `${...}`, punctuation and sentences, and fails.
 * Backslashes are stripped first, because inside a template literal the markdown backticks are
 * escaped (`` \`reticle serve\` ``) and the true positive I was hunting hides behind exactly that.
 */
const SUGGESTION = /`reticle ([a-z][a-z-]*)([^`]*)`/g;
const COMMANDLIKE = /^(?:\s+(?:--?[a-z][a-z-]*|<[a-z-]+>|[a-z0-9./@:-]+))*$/;

/** A comment is a note to a maintainer, not an instruction to a user. */
const IS_COMMENT = /^\s*(?:\/\/|\*|\/\*)/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if ('node_modules' === entry || 'dist' === entry) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('every reticle command we suggest is a command we dispatch', () => {
  const files = sourceFiles(SRC);

  it('finds source to scan (a guard over zero files proves nothing)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('names no verb the parser would call unknown', () => {
    const bad: string[] = [];
    for (const file of files) {
      for (const raw of readFileSync(file, 'utf8').split('\n')) {
        if (IS_COMMENT.test(raw)) continue;
        const line = raw.replaceAll('\\', '');
        for (const match of line.matchAll(SUGGESTION)) {
          const verb = match[1] ?? '';
          if (!COMMANDLIKE.test(match[2] ?? '')) continue; // prose, not advice
          if ('unknown' === knownCommand(verb)) bad.push(`${file.slice(SRC.length + 1)}: ${verb}`);
        }
      }
    }
    expect(
      [...new Set(bad)],
      'these strings tell a human to run a command this CLI does not dispatch',
    ).toEqual([]);
  });
});
