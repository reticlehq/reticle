/**
 * Field and user numbers never appear in anything we publish.
 *
 * Counts and percentages drawn from telemetry live in the gitignored analysis directory and nowhere
 * else: not in code comments, not in docs, not in the changelog, not in commit messages, not in
 * public issues or PRs. Two separate reasons, and each is sufficient on its own.
 *
 * They are ours to hold, not to broadcast. And they rot into confident lies: a comment that says a
 * platform is some exact share of users is a snapshot of one export, written next to code that will
 * outlive it by years, and nobody ever goes back to re-derive it. The number then gets quoted in a
 * decision as though it were current.
 *
 * The rule is not "avoid describing the data". "A large share of users are on Windows" is fine and
 * carries the same engineering weight; it simply cannot go stale into a falsehood. What is banned is
 * the false precision.
 *
 * Written after finding four of these already in the tree, in files whose comments are otherwise
 * careful, plus a test header quoting session counts from a single day's export. It is the same
 * pattern as everything else in this repo: rules a machine enforces have held, and rules left to
 * prose have not.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '@/machine/repo-root.js';
import { publishedPackageDirs } from '@/workspace-packages.js';

const REPO = REPO_ROOT;

/** Everything we publish: source we ship, the docs site, and the reader-facing top-level files. */
// Every package we publish, plus the docs and the skill. It used to say `packages/`, which stopped
// being where the packages are -- and a scan of a directory that does not exist finds nothing and
// passes, which is the worst possible outcome for a check about not publishing numbers.
const SCANNED_ROOTS = [
  ...publishedPackageDirs(),
  join(REPO, 'docs'),
  join(REPO, 'skills'),
] as const;
const SCANNED_FILES = [
  join(REPO, 'CHANGELOG.md'),
  join(REPO, 'README.md'),
  join(REPO, 'SKILL.md'),
] as const;

const TEXT_FILE = /\.(ts|tsx|js|mjs|cjs|md|mdx)$/;
/** Generated or vendored; fixing the source is what matters and `dist` follows on the next build. */
const SKIP_DIR = new Set(['node_modules', 'dist', '.next', 'coverage', 'build']);

function textFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIR.has(entry) || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...textFiles(full));
    else if (TEXT_FILE.test(entry)) out.push(full);
  }
  return out;
}

/**
 * The shapes a field number actually takes, rather than every digit in the repo.
 *
 * Narrow on purpose. A guard that flagged all percentages would hit coverage thresholds, easing
 * curves and CSS, and a guard that cries wolf gets an exemption list and then gets ignored. Each
 * pattern here is a claim about OUR USERS specifically, which is the thing that must not be published
 * and the thing that goes stale.
 */
const FIELD_NUMBER_PATTERNS: readonly { pattern: RegExp; why: string }[] = [
  {
    /*
     * A CLOSED list of nouns that mean people, and `daemons` is one of them — a daemon is a user's
     * machine. It stays closed on purpose: widening it to `them`/`all` caught three BENCH numbers
     * on the first run, and rule 12 says measurements of our own benchmark, suite and install gate
     * are welcome and load-bearing. A guard that cannot tell our numbers from theirs gets an
     * exemption list and then gets ignored.
     */
    pattern: /\b\d+(\.\d+)?%\s+of\s+(users|installs|sessions|runs|agents|projects|tabs|daemons)\b/i,
    why: 'a percentage of our users',
  },
  {
    pattern: /\b\d+\s+of\s+the\s+\d+\s+(users|installs|sessions|runs|agents)\b/i,
    why: 'a count of our users',
  },
  {
    pattern:
      /\b(the|our|yesterday's|today's)\s+(\d{4}-\d{2}(-\d{2})?\s+)?telemetry\s+(shows|says|reports)\s+\d/i,
    why: 'a number attributed to telemetry',
  },
  {
    pattern: /\bby\s+the\s+\d{4}-\d{2}(-\d{2})?\s+telemetry\b/i,
    why: 'a number dated to a telemetry export',
  },
  {
    /*
     * A share of one of OUR EVENTS is a statement about the people who produced it, so the noun
     * that matters is the event name rather than the word "users". Found in the changelog, which
     * rule 12 names explicitly and which npm ships inside every package.
     */
    pattern: /\b\d+(\.\d+)?%\s+of\s+(all\s+)?`?\w+_\w+`?\s*(events)?\b/i,
    why: 'a share of one of our telemetry events',
  },
  {
    pattern: /\b\d+\s+distinct\s+(brand-new\s+)?(users|installs|projects|machines)\b/i,
    why: 'a count of distinct users',
  },
  {
    /*
     * ONE machine, measured. Every pattern above catches an AGGREGATE — a share, a count across
     * installs — and this shape slipped past all of them for months: a possessive reference to a
     * person followed by a size, in a file npm ships, in a comment that is otherwise careful. Rule
     * 12 does not care whether the number is a mean or a single reading; it asks where the number
     * came from, and that one came from somebody's disk.
     *
     * The example is DESCRIBED rather than quoted, deliberately: this file is scanned like every
     * other, so a guard that spells out its own trigger fails on itself. That happened on the first
     * run of this pattern.
     *
     * Deliberately narrow, for the reason the closed noun list above gives. It requires the
     * POSSESSIVE — "a user's", "one user's" — so it cannot reach a bench figure, which says "the
     * install gate" or "the bench" and never claims a person. The unit list is closed for the same
     * reason: "8 GB" and "40 files" are measurements of a machine; a bare integer is not.
     *
     * The gap is the fiddly part and both halves were learned the hard way. It must allow a dot,
     * because the real sentence had a PATH in it (`.reticle/sessions`) and a dot-excluding gap
     * walked straight past the line this was written for. It must NOT allow a SENTENCE break, or
     * it bridges two unrelated clauses -- "...the user's repository by design. They are 37 files"
     * matched, joining a general statement about users to a count of our own files two sentences
     * later. So a dot passes only when nothing follows it but more word: `\.(?!\s)`.
     */
    pattern:
      /\b(a|one|this|that|the)\s+user'?s\b(?:[^.]|\.(?!\s)){0,90}?\b\d+(\.\d+)?\s*(gb|mb|kb|tb|bytes?|files?|sessions?|runs?|hours?|minutes?|seconds?)\b/i,
    why: "a quantity measured from one user's machine",
  },
];

// Reads every shipped source file, every doc and every skill, so it is slow by nature and slower
// again when all the packages' suites run at once. The default five-second budget is a statement
// about how busy the machine is rather than about this code, and this is the last check that should
// ever be weakened to fit inside one -- so it gets time instead.
describe('no published file carries a field or user number', { timeout: 120_000 }, () => {
  const files = [...SCANNED_ROOTS.flatMap(textFiles), ...SCANNED_FILES];

  it('finds files to scan (a green over zero files proves nothing)', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('states no count or percentage drawn from telemetry', () => {
    const found: string[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      /*
       * Matched against a view with comment furniture and line breaks collapsed away, NOT line by
       * line. A line-by-line scan asks "does this sentence fit on one line", and prettier answers
       * that, not the author: `35% of them by the | 2026-08 telemetry` wrapped across two lines and
       * walked past a pattern written to catch exactly it. Every phrase here is a sentence, and a
       * sentence is not a line.
       */
      const flat = text
        .split('\n')
        .map((line) => line.replace(/^\s*(\/\/|\*|\/\*)?\s?/, ''))
        .join(' ')
        .replace(/\s+/g, ' ');
      for (const { pattern, why } of FIELD_NUMBER_PATTERNS) {
        const hit = flat.match(pattern);
        if (hit !== null)
          found.push(`${file.replace(REPO, '.')}: ${why} — ${hit[0].slice(0, 120)}`);
      }
    }

    expect(
      found,
      `These publish a number about our users. Those live only in the gitignored analysis ` +
        `directory. Say the shape instead ("a large share of users are on Windows"): it carries the ` +
        `same engineering weight and cannot rot into a confident falsehood the way an exact figure ` +
        `quoted from one export does.\n${found.join('\n')}`,
    ).toEqual([]);
  });
});
