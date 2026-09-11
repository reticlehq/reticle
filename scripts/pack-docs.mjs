/**
 * Stage the docs and the skill file into `@reticlehq/server` before it is packed.
 *
 * Was four shell commands in the package's prepack — `cp ../../SKILL.md .`, `rm -rf docs`,
 * `cp -R ../../docs .`, `rm -rf docs/images docs/logo docs/favicon docs/matrix`. None of `cp`,
 * `cp -R` or `rm -rf` exists on Windows, so the publish could only ever be cut from a POSIX
 * machine. Node has had `cpSync` since 16; there is no reason for a shell here.
 *
 * The excluded directories are IMAGES, and they are excluded on size: the published tarball is what
 * every user downloads, and a logo is not something anybody reads out of node_modules.
 *
 * The copy also REWRITES links. `docs/` sits at the repo root here and at `packages/server/docs` in
 * the tarball, so every `../CONTRIBUTING.md`, `../apps/README.md` and `../bench/README.md` in the
 * shipped copy resolves inside `packages/server/`, where none of those exist — and the pruned asset
 * directories take `docs/matrix/README.md` with them. Nineteen links, all of them silently dead in
 * the copy every user downloads and agents read out of `node_modules`. Anything that does not exist
 * in the staged output becomes an absolute GitHub URL, computed from where the file lived in the
 * repo. The source docs are untouched: those links are correct where they are written.
 *
 * Source and destination are arguments so the guard in package-payload.test.ts can RUN this against
 * a fixture instead of reading it. That guard used to string-match the prepack for `docs/images`,
 * and when this moved out of the shell the match was satisfied by the sentence three lines above —
 * a green from a comment. Behaviour is the only thing worth asserting here.
 */
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';

const ROOT = process.argv[2] ?? join(import.meta.dirname, '..');
const HERE = process.argv[3] ?? process.cwd();

/** Site assets: every docs image reference is an absolute site path, so none of them resolve here. */
export const PRUNED_ASSET_DIRS = ['images', 'logo', 'favicon', 'matrix'];

/** Deleting into a directory Windows still holds a handle on is the normal case, so retry. */
const GONE = { recursive: true, force: true, maxRetries: 8, retryDelay: 250 };

/** Where a link that does not survive the copy is repointed. `main`, because the tarball is a release. */
const REPO_URL = 'https://github.com/reticlehq/reticle/blob/main/';

/** Inline markdown links. Bare `(target)`, or `(target "title")`; angle-bracket forms are not used here. */
const LINK = /(\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g;

const isExternal = (target) => /^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target);

/** Markdown files under a staged directory, as paths relative to it. */
const markdown = (dir, prefix = '') => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}${entry.name}`;
    if (entry.isDirectory()) out.push(...markdown(join(dir, entry.name), `${rel}/`));
    else if (/\.mdx?$/.test(entry.name)) out.push(rel);
  }
  return out;
};

/**
 * Repoint every relative link that has no file behind it in the staged copy.
 *
 * `staged` is the file's path in the destination, `source` its path relative to the repo root — the
 * two differ in depth, which is the whole defect. Existence is the test rather than `..`-counting:
 * a link into a pruned asset directory does not escape anything and is just as dead.
 */
const relinkFile = (staged, source) => {
  const text = readFileSync(staged, 'utf8');
  const next = text.replace(LINK, (whole, open, target, close) => {
    if (isExternal(target)) return whole;
    const [path, hash = ''] = target.split('#');
    if ('' === path) return whole;
    const landed = resolve(dirname(staged), path);
    if (existsSync(landed) || existsSync(`${landed}.md`) || existsSync(`${landed}.mdx`))
      return whole;
    const inRepo = relative(ROOT, resolve(ROOT, dirname(source), path))
      .split(sep)
      .join(posix.sep);
    return `${open}${REPO_URL}${inRepo}${'' === hash ? '' : `#${hash}`}${close}`;
  });
  if (next !== text) writeFileSync(staged, next);
};

cpSync(join(ROOT, 'SKILL.md'), join(HERE, 'SKILL.md'));

rmSync(join(HERE, 'docs'), GONE);
cpSync(join(ROOT, 'docs'), join(HERE, 'docs'), { recursive: true });
for (const dir of PRUNED_ASSET_DIRS) rmSync(join(HERE, 'docs', dir), GONE);

relinkFile(join(HERE, 'SKILL.md'), 'SKILL.md');
for (const rel of markdown(join(HERE, 'docs'))) {
  relinkFile(join(HERE, 'docs', rel), `docs/${rel}`);
}

console.error('pack-docs: staged SKILL.md and docs (images excluded, escaped links absolutised)');
