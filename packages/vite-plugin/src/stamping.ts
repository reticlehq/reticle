/**
 * Which files get a `data-reticle-source` stamp, and how.
 *
 * Split out of index.ts when that file crossed the line cap while gaining the per-file opt-out.
 * This is one concern — a module id comes in, and either a stamper runs on it, nothing does, or the
 * file has asked to be left alone — and it changes for one reason (the source-pointer feature)
 * rather than for the dozen the plugin's lifecycle does. The Svelte stamper is its sibling module;
 * the JSX one is `@reticlehq/babel-plugin`, which also reads the opt-out on its own for the callers
 * that reach it without Vite.
 */

import { transformSync } from '@babel/core';
import reticleSource from '@reticlehq/babel-plugin';
import { isSourceStampingIgnored } from '@reticlehq/babel-plugin/ignore';
import { RETICLE_IGNORE_MARKER } from '@reticlehq/core';
import { SVELTE_FILE } from './svelte-source.js';

/** Files we stamp with source info — JSX/TSX only. */
const JSX_FILE = /\.[jt]sx$/;
/** Rollup virtual-module ids start with a NUL byte; never transform those. */
const VIRTUAL_PREFIX = '\0';
const NODE_MODULES = 'node_modules';

/** A module id we may stamp at all: not virtual, not a dependency. Extension decides which stamper. */
export function stampableId(id: string): string | null {
  if (id.startsWith(VIRTUAL_PREFIX)) return null;
  if (id.includes(NODE_MODULES)) return null;
  // Strip any query suffix (?worker, ?raw,...) before matching the extension.
  return id.split('?')[0] ?? id;
}

export function shouldStamp(id: string): boolean {
  const clean = stampableId(id);
  return clean !== null && JSX_FILE.test(clean);
}

/** A `.svelte` single-file component, which needs the Svelte stamper rather than Babel. */
export function shouldStampSvelte(id: string): boolean {
  const clean = stampableId(id);
  return clean !== null && SVELTE_FILE.test(clean);
}

export function stamp(code: string, id: string): { code: string; map: string | null } | null {
  const out = transformSync(code, {
    filename: id,
    plugins: [reticleSource],
    parserOpts: { plugins: ['jsx', 'typescript'] },
    sourceMaps: true,
    configFile: false,
    babelrc: false,
  });
  if (out?.code === undefined || null === out.code) return null;
  return {
    code: out.code,
    map: out.map === undefined || null === out.map ? null : JSON.stringify(out.map),
  };
}

/**
 * Has this file asked not to be stamped?
 *
 * Decided ahead of BOTH stampers, so the Svelte path honours the marker too and so the opt-out is
 * announced once regardless of which stamper would have run. Only a file one of them would have
 * touched can opt out — an id that was never stampable has nothing to announce (#853).
 */
export function optsOutOfStamping(code: string, id: string): boolean {
  return (shouldStamp(id) || shouldStampSvelte(id)) && isSourceStampingIgnored(code);
}

/**
 * The one line said when a file opts out of source stamping with `@reticle-ignore`.
 *
 * Not silent, on purpose. An opt-out nobody is told about is an opt-out somebody forgets, and the
 * `file:line` it would have produced quietly stops resolving months later with nothing to point at
 * the comment. Said once per file, in the dev-server output where the person who added the comment
 * will see it. Exported for the test that pins the wording.
 */
export function ignoredFileNotice(id: string): string {
  return `[reticle] ${id} opts out of source stamping (${RETICLE_IGNORE_MARKER} on its first line) — elements in it will have no file:line.`;
}
