/**
 * Assemble `.changes/*.md` into the `[Unreleased]` section of `CHANGELOG.md`.
 *
 *   node scripts/assemble-changelog.mjs --dry-run   # print what would be written, touch nothing
 *   node scripts/assemble-changelog.mjs             # write it, delete the consumed entry files
 *
 * `CHANGELOG.md` was the largest merge-conflict source in the repo — 23 of 42 open PRs edited it,
 * 11 of them conflicting, always in the same place: two branches appending to `[Unreleased]`. The
 * policy (entry lands with the change) was right, the mechanism was wrong. One file per entry means
 * two PRs add two files and never collide; this script is the other half, run once at release.
 *
 * Deliberately a MERGE, not a rewrite: existing bullets under `[Unreleased]` are left exactly where
 * they are, in the order they were written. The only thing this moves is what it adds.
 */
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const CHANGES = join(ROOT, '.changes');
const CHANGELOG = join(ROOT, 'CHANGELOG.md');
const UNRELEASED = '## [Unreleased]';

/** Keep a Changelog's six, in its order. Anything else an entry names is kept, after these. */
const CANONICAL = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];

/** `### Heading` → the lines under it, for one `## ` section. Insertion order is preserved. */
const splitSubsections = (lines) => {
  const out = new Map();
  let heading = '';
  const preamble = [];
  for (const line of lines) {
    const match = /^### (.+)$/.exec(line);
    if (null !== match) {
      heading = match[1].trim();
      if (!out.has(heading)) out.set(heading, []);
      continue;
    }
    if ('' === heading) preamble.push(line);
    else out.get(heading).push(line);
  }
  return { preamble, sections: out };
};

/** Drop leading and trailing blank lines; a bullet list with holes at both ends renders wrong. */
const trimBlanks = (lines) => {
  let a = 0;
  let b = lines.length;
  while (a < b && '' === lines[a].trim()) a += 1;
  while (b > a && '' === lines[b - 1].trim()) b -= 1;
  return lines.slice(a, b);
};

/** One `.changes/*.md` file → `{ heading, body }`. Throws with the filename on anything malformed. */
const parseEntry = (name, text) => {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => '' !== l.trim());
  const match = -1 === at ? null : /^### (.+)$/.exec(lines[at]);
  if (null === match) {
    throw new Error(
      `.changes/${name}: the first non-blank line must be a heading like '### Fixed'. ` +
        `See .changes/README.md.`,
    );
  }
  const body = trimBlanks(lines.slice(at + 1));
  if (0 === body.length) throw new Error(`.changes/${name}: has a heading and no entry under it.`);
  return { heading: match[1].trim(), body };
};

const entryFiles = () =>
  readdirSync(CHANGES)
    .filter((f) => f.endsWith('.md') && 'README.md' !== f)
    .sort();

const assemble = (changelog, entries) => {
  const lines = changelog.split('\n');
  const start = lines.indexOf(UNRELEASED);
  if (-1 === start) throw new Error(`CHANGELOG.md has no '${UNRELEASED}' heading.`);
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith('## ')) end += 1;

  const { preamble, sections } = splitSubsections(lines.slice(start + 1, end));
  for (const { heading, body } of entries) {
    if (!sections.has(heading)) sections.set(heading, []);
    sections.get(heading).push(...body);
  }

  const known = CANONICAL.filter((h) => sections.has(h));
  const extra = [...sections.keys()].filter((h) => !CANONICAL.includes(h));
  const rendered = [];
  for (const heading of [...known, ...extra]) {
    const body = trimBlanks(sections.get(heading));
    if (0 === body.length) continue;
    rendered.push(`### ${heading}`, '', ...body, '');
  }

  const head = trimBlanks(preamble);
  return [
    ...lines.slice(0, start + 1),
    '',
    ...(0 === head.length ? [] : [...head, '']),
    ...rendered,
    ...lines.slice(end),
  ].join('\n');
};

const dryRun = process.argv.includes('--dry-run');
const files = entryFiles();
if (0 === files.length) {
  console.error('assemble-changelog: no entries in .changes/, nothing to do');
  process.exit(0);
}

const entries = files.map((f) => parseEntry(f, readFileSync(join(CHANGES, f), 'utf8')));
const next = assemble(readFileSync(CHANGELOG, 'utf8'), entries);

if (dryRun) {
  process.stdout.write(next);
  console.error(`\nassemble-changelog: --dry-run, wrote nothing. ${String(files.length)} entries:`);
  for (const f of files) console.error(`  .changes/${f}`);
  process.exit(0);
}

writeFileSync(CHANGELOG, next);
for (const f of files) rmSync(join(CHANGES, f));
console.error(
  `assemble-changelog: spliced ${String(files.length)} entries into ${UNRELEASED} and removed them from .changes/`,
);
