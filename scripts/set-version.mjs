#!/usr/bin/env node
/**
 * Set one version across every file that carries it.
 *
 * RELEASING.md used to spend three steps on this: `pnpm version`, `pnpm -r exec npm version`, and a
 * hand-written `sed -i '' '3s/…/…/' adapters/realm/tauri/Cargo.toml`. That last one is addressed by LINE
 * NUMBER — add a comment above `version` in Cargo.toml and it silently rewrites the wrong line, in
 * the one file whose drift has already shipped once (the crate sat at 0.1.0 for months, green every
 * time). The two pnpm commands also cover only `package.json`; everything else was a human
 * remembering, backed by four guards that could only tell you afterwards.
 *
 * Those guards are why this is safe to automate rather than the reason not to: they stay exactly as
 * they are and become this script's negative control. Run the script, run the gate; if a site was
 * missed, a test says which.
 *
 * Usage:
 *   node scripts/set-version.mjs 2.14.0
 *   node scripts/set-version.mjs 2.14.0 --dry-run
 *
 * Deliberately NOT touched: CHANGELOG.md (prose, and `.changes/` assembles it), pnpm-lock.yaml
 * (regenerate with `pnpm install --lockfile-only`), and Cargo.lock's dependency graph — only the
 * `reticle-tauri` package's own entry is rewritten, because that is the one cargo will not update
 * without a network fetch.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const [, , nextVersion, ...flags] = process.argv;
const DRY_RUN = flags.includes('--dry-run');

if (undefined === nextVersion || !SEMVER.test(nextVersion)) {
  console.error('usage: node scripts/set-version.mjs <version> [--dry-run]');
  console.error('       version must be MAJOR.MINOR.PATCH, e.g. 2.14.0');
  process.exit(1);
}

/** Every tracked file, so a new package or skill is covered the day it lands rather than the day someone remembers. */
const tracked = (...patterns) =>
  execFileSync('git', ['ls-files', ...patterns], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.length > 0);

const current = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;

/**
 * One edit rule per shape.
 *
 * Each is anchored on the KEY, never on a line number, and each replaces only the version it was
 * told to expect. A file that does not currently hold `current` is reported as untouched rather
 * than silently rewritten — that is the signal that a site has drifted, and it should be loud.
 */
const RULES = [
  {
    what: 'package.json version field',
    files: () =>
      tracked('package.json', '*/package.json', '*/*/package.json', '*/*/*/package.json'),
    edit: (text, from, to) => text.replace(`"version": "${from}"`, `"version": "${to}"`),
  },
  {
    what: 'plugin + marketplace manifests',
    files: () => ['plugin/.claude-plugin/plugin.json', '.claude-plugin/marketplace.json'],
    edit: (text, from, to) => text.replace(`"version": "${from}"`, `"version": "${to}"`),
  },
  {
    what: 'docs.json site version',
    files: () => ['docs/docs.json'],
    edit: (text, from, to) => text.replace(`"version": "${from}"`, `"version": "${to}"`),
  },
  {
    what: 'SKILL.md frontmatter',
    files: () => tracked('plugin/SKILL.md', 'skills/*/SKILL.md'),
    edit: (text, from, to) => text.replace(`version: ${from}`, `version: ${to}`),
  },
  {
    what: 'crate manifest',
    files: () => ['adapters/realm/tauri/Cargo.toml'],
    // Anchored on the key, not on line 3. This is the site RELEASING.md addressed positionally.
    edit: (text, from, to) => text.replace(`version = "${from}"`, `version = "${to}"`),
  },
  {
    what: 'crate lockfile (own entry only)',
    files: () => ['adapters/realm/tauri/Cargo.lock'],
    edit: (text, from, to) =>
      text.replace(
        `name = "reticle-tauri"\nversion = "${from}"`,
        `name = "reticle-tauri"\nversion = "${to}"`,
      ),
  },
  {
    what: 'compat-matrix staleness banner',
    // The banner names the CURRENT release, so a bump that skipped it would leave
    // `matrix-freshness.test.ts` red — correctly, but for a confusing reason.
    files: () => ['docs/matrix/MATRIX.md', 'docs/matrix/README.md'],
    edit: (text, from, to) =>
      text.split(`**${from}**`).join(`**${to}**`).split(`is ${from}.`).join(`is ${to}.`),
  },
  {
    what: 'crate pin in docs (major.minor, Cargo caret semantics)',
    // These read `reticle-tauri = "2.13"`, not the full version — a caret pin, which is the correct
    // thing for a Cargo dependency and the reason the whole-version replace above cannot see them.
    // `crate-version-lockstep.test.ts` caught exactly this on the 2.14.0 bump; it is why the rule
    // exists rather than a fourth place someone has to remember.
    files: () => tracked('docs/*.mdx', 'docs/**/*.mdx'),
    matchesAnyVersion: true,
    edit: (text, _from, to) => {
      const minor = to.split('.').slice(0, 2).join('.');
      return text.replace(/reticle-tauri = "\d+\.\d+"/g, `reticle-tauri = "${minor}"`);
    },
  },
];

let changed = 0;
let skipped = 0;

for (const rule of RULES) {
  for (const file of rule.files()) {
    const path = join(REPO, file);
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      console.log(`  ??  ${file} — listed by a rule but not present`);
      continue;
    }
    if (true !== rule.matchesAnyVersion && !text.includes(current)) {
      skipped += 1;
      continue;
    }
    const next = rule.edit(text, current, nextVersion);
    if (next === text) {
      // A rule that opts out of the containment check above is asking to SEE every file in its
      // glob, not claiming every file needs changing. The crate-pin rule reads all of `docs/`
      // and edits only the pages carrying `reticle-tauri = "X.Y"`, so a no-op is the expected
      // answer for the rest -- and reporting it as "holds <version> but no rule matched"
      // produced 74 warnings naming pages that contain no version string at all.
      //
      // A warning channel that is 74/74 false is worse than none: the person reading it at
      // release time learns to scroll past, and the one true warning goes with them.
      if (true === rule.matchesAnyVersion) continue;
      console.log(`  !!  ${file} — holds ${current} but no rule matched it (${rule.what})`);
      continue;
    }
    if (!DRY_RUN) writeFileSync(path, next);
    console.log(`  ->  ${file}`);
    changed += 1;
  }
}

console.log(
  `\nset-version: ${current} -> ${nextVersion} across ${String(changed)} file(s)` +
    `${DRY_RUN ? ' (--dry-run, wrote nothing)' : ''}. ${String(skipped)} tracked file(s) did not carry ${current}.`,
);

if (0 === changed) {
  console.error(`\nNothing changed. Is the repo already at ${nextVersion}?`);
  process.exit(1);
}

if (!DRY_RUN) {
  console.log('\nNext: pnpm install --lockfile-only, then the unit gate — the version guards are');
  console.log('the negative control for this script, so a missed site shows up there by name.');
}
