/**
 * The published tarball must stay small enough to publish.
 *
 * `prepack` copies the whole of `docs/` into the package so an agent can read the guides straight
 * out of `node_modules`. `docs/images/` then grew three benchmark screenshots of about three
 * megabytes each, and the tarball crossed the local registry's body limit. The install gate could
 * not even reach its first scaffold: it died in setup with a 413 while publishing, which reads as
 * "the gate is broken" rather than "the package got too big", so the failure pointed away from its
 * own cause.
 *
 * The images were dead weight in there regardless. Every reference in the docs is an absolute site
 * path (`/images/...`), which resolves on docs.reticle.sh and resolves nowhere at all inside
 * `node_modules` — so shipping them bought no reader anything and cost every install the download.
 *
 * This guard is on the SOURCE rather than on a built tarball, deliberately: building one takes a
 * minute and this has to fail in the fast gate, which is the only gate that always runs. It asks
 * the two questions that actually broke: is prepack still pruning the asset directories, and has
 * anything large appeared in the part of `docs/` that does get shipped.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { REPO_ROOT } from '../repo-root.js';

const REPO = REPO_ROOT;
const DOCS = join(REPO, 'docs');

/** Directories `prepack` deletes after copying `docs/`. Assets the site serves and npm need not. */
const PRUNED = ['images', 'logo', 'favicon', 'matrix'] as const;

/**
 * Generous on purpose. This is not a size budget, it is a tripwire for the class of thing that
 * broke: a multi-megabyte binary landing somewhere the tarball picks up.
 */
const MAX_SHIPPED_FILE_BYTES = 512 * 1024;

const prepack = (): string => {
  const pkg: unknown = JSON.parse(readFileSync(join(REPO, 'server/package.json'), 'utf8'));
  const scripts = (pkg as { scripts?: Record<string, string> }).scripts ?? {};
  return scripts.prepack ?? '';
};

/** Everything under `docs/` that survives the prune, i.e. everything the tarball carries. */
const shippedDocs = (dir = DOCS, prefix = ''): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      if (!PRUNED.includes(entry.name as (typeof PRUNED)[number])) {
        out.push(...shippedDocs(join(dir, entry.name), `${rel}/`));
      }
      continue;
    }
    out.push(rel);
  }
  return out;
};

describe('the published package does not carry the docs site assets', () => {
  // RUN, not read. This used to string-match the prepack for `docs/images`; when the copy moved out
  // of the shell into pack-docs.mjs so it could run on Windows, the match was satisfied by a COMMENT
  // in that script quoting the shell it replaced — the guard went green with the pruning deleted.
  // Verified the new one by deleting the prune loop and watching it redden.
  it('prepack prunes every asset directory after copying docs', () => {
    expect(prepack(), 'prepack no longer stages docs; this guard needs rewriting').toContain(
      'pack-docs.mjs',
    );

    // A fixture standing in for the repo: one file per asset directory, plus one real doc.
    const src = mkdtempSync(join(tmpdir(), 'reticle-packdocs-src-'));
    const dest = mkdtempSync(join(tmpdir(), 'reticle-packdocs-dest-'));
    try {
      writeFileSync(join(src, 'SKILL.md'), '# skill');
      mkdirSync(join(src, 'docs'), { recursive: true });
      writeFileSync(join(src, 'docs', 'usage.md'), '# usage');
      for (const dir of PRUNED) {
        mkdirSync(join(src, 'docs', dir), { recursive: true });
        writeFileSync(join(src, 'docs', dir, 'asset.bin'), 'x');
      }

      execFileSync(process.execPath, [join(REPO, 'scripts/pack-docs.mjs'), src, dest], {
        stdio: 'ignore',
      });

      const staged = readdirSync(join(dest, 'docs'));
      expect(staged, 'the docs themselves must still be staged').toContain('usage.md');
      const kept = PRUNED.filter((d) => staged.includes(d));
      expect(
        kept,
        `pack-docs copied docs/ but left ${kept.join(', ')} in place. Those are site assets: every ` +
          `image reference in the docs is an absolute site path, so they resolve on docs.reticle.sh ` +
          `and nowhere inside node_modules. Shipping them only makes the tarball too large to publish.`,
      ).toEqual([]);
    } finally {
      rmSync(src, { recursive: true, force: true });
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it('nothing large has appeared in the part of docs/ that ships', () => {
    const heavy = shippedDocs()
      .map((rel) => ({ rel, bytes: statSync(join(DOCS, rel)).size }))
      .filter((f) => f.bytes > MAX_SHIPPED_FILE_BYTES);

    expect(
      heavy.map((f) => `${f.rel} (${Math.round(f.bytes / 1024)}KB)`),
      `These files ship inside @reticlehq/server and are large. Either move them under an asset ` +
        `directory prepack prunes, or reference them from the docs site instead of committing them ` +
        `where the tarball picks them up.`,
    ).toEqual([]);
  });
});

/**
 * `docs/` lives at the repo root and lands at `server/docs` in the tarball, so the copy
 * changes its depth. Every `../CONTRIBUTING.md`, `../apps/README.md`, `../bench/README.md` and
 * `../apps/e2e/harness-rules.md` in the shipped copy then resolves inside `server/`, where
 * none of them exist — and the asset prune above takes `docs/matrix/` with it, killing three more.
 * Nineteen dead links in the copy every user downloads and every agent reads out of `node_modules`,
 * and nothing could see them: the source docs are correct where they are written, so no docs guard
 * fires, and the breakage exists only in an artifact no test built.
 *
 * So this one BUILDS it. `pack-docs.mjs` now repoints anything with no file behind it at
 * `github.com/reticlehq/reticle/blob/main/...`; existence in the staged tree is the test, not
 * counting `..`, because a link into a pruned directory escapes nothing and is just as dead.
 */
describe('the docs inside the published package still resolve', () => {
  /** Inline links with a local target: not a URL, not an anchor, not a site-absolute path. */
  const LINK = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

  const markdown = (dir: string, prefix = ''): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) out.push(...markdown(join(dir, entry.name), `${rel}/`));
      else if (/\.mdx?$/.test(entry.name)) out.push(rel);
    }
    return out;
  };

  it('no relative link in the staged copy points outside it', () => {
    const dest = mkdtempSync(join(tmpdir(), 'reticle-packdocs-links-'));
    try {
      execFileSync(process.execPath, [join(REPO, 'scripts/pack-docs.mjs'), REPO, dest], {
        stdio: 'ignore',
      });

      const dead: string[] = [];
      for (const rel of markdown(dest)) {
        const file = join(dest, rel);
        for (const [, target] of readFileSync(file, 'utf8').matchAll(LINK)) {
          if (undefined === target || /^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) continue;
          const path = target.split('#')[0];
          if (undefined === path || '' === path) continue;
          const landed = resolve(dirname(file), path);
          const here =
            existsSync(landed) || existsSync(`${landed}.md`) || existsSync(`${landed}.mdx`);
          if (!here) dead.push(`${rel} -> ${target}`);
        }
      }

      expect(
        dead,
        `These links resolve to nothing inside the published package. docs/ changes depth when it ` +
          `is copied into server/, so a link that is correct in the repo is dead in the ` +
          `tarball — and the pruned asset directories kill the rest. pack-docs.mjs is supposed to ` +
          `repoint them at ${'https://github.com/reticlehq/reticle/blob/main/'}; fix it there, not ` +
          `in the source docs, which are correct where they are written.`,
      ).toEqual([]);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });
});
