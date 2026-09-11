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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');

/** Everything we publish: source we ship, the docs site, and the reader-facing top-level files. */
const SCANNED_ROOTS = [join(REPO, 'packages'), join(REPO, 'docs'), join(REPO, 'skills')] as const;
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
    pattern: /\b\d+(\.\d+)?%\s+of\s+(users|installs|sessions|runs|agents|projects|tabs)\b/i,
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
];

describe('no published file carries a field or user number', () => {
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
      text.split('\n').forEach((line, i) => {
        for (const { pattern, why } of FIELD_NUMBER_PATTERNS) {
          if (pattern.test(line)) {
            found.push(
              `${file.replace(REPO, '.')}:${i + 1}: ${why} — ${line.trim().slice(0, 120)}`,
            );
          }
        }
      });
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
