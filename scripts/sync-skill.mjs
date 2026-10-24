#!/usr/bin/env node
/**
 * Writes every published copy of the skill from the one hand-written body, root `SKILL.md`.
 *
 * Each copy is its own frontmatter plus the root body, with the install-source marker set to the
 * channel that serves it.
 *
 * `npx skills add reticlehq/reticle --skill reticle` installed the whole `docs/` directory on a
 * case-insensitive file system (`docs/skill.md` matched `SKILL.md`), and `plugin/` on Linux. The
 * CLI walks the repository root one level deep first, and the first skill with a name wins, also
 * when the name is `internal`. So the plugin sits two levels deep, in `plugins/reticle/`, and
 * the docs copy has its own name. Both declare `metadata.internal: true`, so a plain list does not
 * show them.
 *
 *   node scripts/sync-skill.mjs           write the copies
 *   node scripts/sync-skill.mjs --check   exit 1 if a committed copy differs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CANONICAL_MARKER = 'RETICLE_INSTALL_SOURCE=skill_file';
const LATEST_INIT = '@reticlehq/server@latest init';
const DESCRIPTION =
  'Install, instrument and verify this running web app from the inside (DOM, network, routing, console and framework state) instead of screenshots or guessing. Drives one real flow end to end and returns a verdict with the file:line to fix. Use when the user asks to set up or install Reticle, when a user-facing change needs proving before you call it done, when a test passes but the UI is broken, or when the user types /reticle.';
const ALIAS_DESCRIPTION =
  'Verify that a web app change actually works by driving the running app from the inside (DOM, network, routing, console, framework state) instead of screenshots or guessing. Use after any user-facing change, when a fix is claimed but unproven, when a test passes but the UI is broken, or when you need a real verdict rather than "looks right". Also use to install and wire up Reticle in a project that does not have it yet.';

/** Each generated copy: where it goes, its frontmatter fields, and its install-source marker. */
export const SKILL_COPIES = [
  {
    path: 'docs/skill.md',
    name: 'reticle-docs',
    description: DESCRIPTION,
    homepage: 'https://docs.reticle.sh',
    source: 'skill_file',
    internal: true,
  },
  {
    path: 'plugins/reticle/SKILL.md',
    name: 'reticle',
    description: DESCRIPTION,
    homepage: 'https://www.reticle.sh',
    source: 'plugin',
    internal: true,
    // The plugin pins its daemon to this release, so its `init` must install the same SDK.
    pinInit: true,
  },
  {
    path: 'skills/reticle/SKILL.md',
    name: 'reticle',
    description: DESCRIPTION,
    homepage: 'https://www.reticle.sh',
    source: 'npx_skill',
    internal: false,
  },
  {
    path: 'skills/install-and-verify/SKILL.md',
    name: 'install-and-verify',
    description: ALIAS_DESCRIPTION,
    homepage: 'https://www.reticle.sh',
    source: 'npx_skill',
    internal: false,
  },
];

/** The expected text of every copy, keyed by its repository path. */
export function syncSkill(root = ROOT) {
  const body = readFileSync(join(root, 'SKILL.md'), 'utf8');
  if (!body.includes(CANONICAL_MARKER)) throw new Error(`SKILL.md must carry ${CANONICAL_MARKER}`);
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const out = new Map();
  for (const copy of SKILL_COPIES) {
    const frontmatter = [
      '---',
      `name: ${copy.name}`,
      `description: ${copy.description}`,
      'license: Apache-2.0',
      'metadata:',
      `  version: ${version}`,
      `  homepage: ${copy.homepage}`,
      '  repository: https://github.com/reticlehq/reticle',
      ...(copy.internal ? ['  internal: true'] : []),
      '---',
      '',
      '',
    ].join('\n');
    const marked = body.split(CANONICAL_MARKER).join(`RETICLE_INSTALL_SOURCE=${copy.source}`);
    const text = copy.pinInit
      ? marked.split(LATEST_INIT).join(`@reticlehq/server@${version} init`)
      : marked;
    out.set(copy.path, frontmatter + text);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const stale = [];
  for (const [path, text] of syncSkill()) {
    const file = join(ROOT, path);
    let current;
    try {
      current = readFileSync(file, 'utf8');
    } catch {
      current = undefined;
    }
    if (current === text) continue;
    stale.push(path);
    if (!check) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
  }
  if (check && stale.length > 0) {
    process.stderr.write(`Out of date, run pnpm skill:sync: ${stale.join(', ')}\n`);
    process.exit(1);
  }
}
