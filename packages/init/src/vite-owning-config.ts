/**
 * Patching a build config that owns its own Vite instance.
 *
 * Astro and Nuxt are the same problem twice: each runs Vite itself and renders its own HTML, so the
 * Vite plugin never loads and nothing sits in the page's path to inject the pairing token. So the
 * token has to be inlined by the config, the dep cache has to be warmed for the dynamic SDK import,
 * and the daemon's journal has to be kept out of the dev-server watcher — three edits to one `vite:`
 * block, merged into whatever the app already put there.
 *
 * Lifted out of `astro-patch.ts` unchanged when Nuxt needed the identical patch. The two frameworks
 * differ in exactly two ways, and both are parameters here: the config-factory call to extend
 * (`defineConfig` / `defineNuxtConfig`), and which SDK package to pre-bundle.
 *
 * Every branch bails to `manual` (the printed recipe) on a shape it does not fully recognise.
 * Half-editing somebody's build config is worse than a documented manual step.
 */

import { ReticleDir } from '@reticlehq/core';
import { blockAfter } from './brace-scan.js';
import { PatchKind, type SourcePatch } from './patch-kind.js';

/** What differs between one Vite-owning framework and the next. */
export interface ViteOwningConfig {
  /** The config-factory call whose object literal our `vite:` block goes into. */
  readonly defineCall: RegExp;
  /** The SDK package this framework's connect imports, declared so Vite pre-bundles it. */
  readonly sdkSpecifier: string;
}

/** Present in a patched config AND in a hand-followed recipe — so both count as already wired. */
const CONFIG_MARKER = '__RETICLE_TOKEN__';

/**
 * The SDK, declared so Vite pre-bundles it BEFORE the first page load.
 *
 * The connect does `await import('@reticlehq/react')`. Undeclared, Vite meets that import mid-load,
 * pre-bundles it, and the hashed `/node_modules/.vite/deps/@reticlehq_react.js?v=…` URL the browser
 * already requested stops existing — the import rejects with "Failed to fetch dynamically imported
 * module", connect() never runs, and the page looks entirely normal. Measured on astro-nanostores,
 * intermittent on whether the dep cache was warm. The Vite plugin has declared the SDK for this
 * exact reason since the bug was first found on React; a hand-patched config never got it.
 */
function sdkInclude(config: ViteOwningConfig): string {
  return `'${config.sdkSpecifier}'`;
}

/**
 * The daemon's journal directory, kept out of the dev server's watcher.
 *
 * The daemon writes `.reticle/` into the project root and rewrites `ambient.json` atomically
 * (`.tmp` + rename) for as long as a session is live. These dev servers are Vite watching that root,
 * and `.reticle/` is not in Vite's default ignore list — so every journal write read as a project
 * file changing and Vite answered with a full page reload. That closes a loop with no exit: the page
 * loads, the SDK connects and streams events, the daemon journals them, Vite reloads the page, the
 * SDK reconnects. It ran several times a second for as long as the dev server was up, and the
 * symptom looked nothing like the cause — stale refs, actions dying mid-flight, and a log full of
 * connect/disconnect pairs that read as a flapping SDK.
 *
 * The Vite plugin sets the same ignore in its `config` hook. These frameworks never load that
 * plugin, so they need their own.
 *
 * A RegExp, not a glob. chokidar dropped glob support in v4 and Vite 7+ ships v4/v5, where a
 * double-star pattern is accepted and matches nothing — the ignore would be visibly present in the
 * config and do nothing at all. Measured against the chokidar this repo resolves.
 */
const WATCH_IGNORE_LITERAL = `/(^|[\\\\/])\\.${ReticleDir.ROOT.slice(1)}([\\\\/]|$)/`;

/**
 * An `include:` the app already declared — ours joins that array instead of adding a second key.
 * Deliberately not anchored to a newline: `optimizeDeps: { include: ['x'] }` on one line is the
 * common way to write it, and requiring a line break made the merge miss it and duplicate the key.
 */
const EXISTING_INCLUDE = /(\s*include\s*:\s*\[)/;

/** A `vite:` key whose value is an object LITERAL — the one shape we can merge into safely. */
const VITE_OBJECT_KEY = /(^\s*vite\s*:\s*\{)/m;
/** Any `vite:` key at all. One that is not an object literal (a spread, an imported config) is ours to refuse. */
const ANY_VITE_KEY = /^\s*vite\s*:/m;

const HELPER = `
function reticleToken() {
  const dir = process.env['RETICLE_PAIRING_TOKEN_DIR'] || join(homedir(), '.reticle');
  try { return readFileSync(join(dir, 'pairing-token'), 'utf8').trim(); } catch { return ''; }
}
`;

const HELPER_IMPORTS = `import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
`;

/**
 * The keys we add inside `vite:`, each with what it must contain.
 *
 * Kept as a list rather than one blob because a config that already sets one of these must be merged
 * INTO, not duplicated: the real astro-nanostores config has `build: { chunkSizeWarningLimit }`, and
 * inserting our own `build` beside it gave the object two — where the last one wins, so
 * `target: 'es2022'` was silently discarded while init reported success. Losing that target is not
 * cosmetic: Astro's default down-levels the modern SDK bundle and dies on a destructuring transform.
 */
function viteKeys(config: ViteOwningConfig): readonly { key: string; inner: string }[] {
  return [
    { key: 'build', inner: `\n      target: 'es2022',` },
    {
      key: 'optimizeDeps',
      inner: `\n      include: [${sdkInclude(config)}],\n      esbuildOptions: { target: 'es2022' },`,
    },
    {
      key: 'define',
      inner: `\n      __RETICLE_TOKEN__: JSON.stringify(reticleToken()),\n      __RETICLE_ROOT__: JSON.stringify(process.cwd()),`,
    },
    // Merged in first, so a `server: { port }` the app already set keeps its port. An app that
    // already sets `server.watch` itself is the one shape this loses to — the inner `watch` key would
    // be duplicated and the app's would win — which is the same nested-merge ceiling `build` has.
    { key: 'server', inner: `\n      watch: { ignored: [${WATCH_IGNORE_LITERAL}] },` },
  ];
}

/** Whole-key form, for a `vite:` block that does not have the key at all. */
function wholeKeys(config: ViteOwningConfig): Readonly<Record<string, string>> {
  return {
    build: `\n    build: { target: 'es2022' },`,
    optimizeDeps: `\n    optimizeDeps: { include: [${sdkInclude(config)}], esbuildOptions: { target: 'es2022' } },`,
    define: `\n    define: {\n      __RETICLE_TOKEN__: JSON.stringify(reticleToken()),\n      __RETICLE_ROOT__: JSON.stringify(process.cwd()),\n    },`,
    server: `\n    server: { watch: { ignored: [${WATCH_IGNORE_LITERAL}] } },`,
  };
}

/**
 * Add our keys to an existing `vite: { ... }` block, merging into any the app already set.
 *
 * Returns null when a colliding key is not an object literal (`build: sharedConfig`) — there is no
 * brace to merge into, and duplicating or replacing it would corrupt someone's build.
 */
function mergeIntoViteBlock(
  source: string,
  braceAt: number,
  config: ViteOwningConfig,
): string | null {
  let out = source;
  const whole = wholeKeys(config);
  for (const { key, inner } of viteKeys(config)) {
    // Scoped to the vite block by searching from its opening brace: a `build:` under `markdown:` or
    // at the top level is somebody else's key and must not be touched.
    const existing = new RegExp(`(\\n\\s*${key}\\s*:\\s*)([\\{A-Za-z_])`).exec(out.slice(braceAt));
    if (existing?.index === undefined) {
      out = `${out.slice(0, braceAt)}${whole[key] ?? ''}${out.slice(braceAt)}`;
      continue;
    }
    // The character after the colon decides: `{` is a literal we can open; anything else is a
    // reference we must not touch.
    if (existing[2] !== '{') return null;
    const at = braceAt + existing.index + existing[0].length; // just past the `{`
    // An `include:` the app already wrote is an ARRAY, and a second `include:` key in the same
    // object literal is not a merge — the last one wins and one of the two silently disappears.
    // That is how `build.target` was lost while init still reported success. Join their array.
    // Scoped to THIS block's braces: an `include:` under a later key is somebody else's array, and
    // appending the SDK to it would both miss the target and edit a config we were not asked to.
    const own = 'optimizeDeps' === key ? EXISTING_INCLUDE.exec(blockAfter(out, at)) : null;
    if (own?.index === undefined) {
      out = insertAt(out, at, inner);
      continue;
    }
    // Their array first, then the rest of our keys at the block's start — inserting at the LOWER
    // offset second keeps the first offset valid.
    out = insertAt(out, at + own.index + own[0].length, `${sdkInclude(config)}, `);
    out = insertAt(out, at, withoutInclude(inner, config));
  }
  return out;
}

function insertAt(source: string, at: number, text: string): string {
  return `${source.slice(0, at)}${text}${source.slice(at)}`;
}

/** The optimizeDeps inner minus our `include:` line, for when the app already has one to join. */
function withoutInclude(inner: string, config: ViteOwningConfig): string {
  return inner.replace(`\n      include: [${sdkInclude(config)}],`, '');
}

/**
 * The `vite:` block these frameworks need. `build.target` is raised because Astro's default
 * down-levels the modern SDK bundle and dies on a destructuring transform; `__RETICLE_ROOT__` is
 * defined because without it every source pointer comes back as an absolute path from the machine
 * that ran `init`.
 */
function viteBlock(config: ViteOwningConfig): string {
  return `  vite: {
    build: { target: 'es2022' },
    optimizeDeps: { include: [${sdkInclude(config)}], esbuildOptions: { target: 'es2022' } },
    define: {
      __RETICLE_TOKEN__: JSON.stringify(reticleToken()),
      __RETICLE_ROOT__: JSON.stringify(process.cwd()),
    },
    server: { watch: { ignored: [${WATCH_IGNORE_LITERAL}] } },
  },
`;
}

export function patchViteOwningConfig(source: string, config: ViteOwningConfig): SourcePatch {
  if (source.includes(CONFIG_MARKER)) return { kind: PatchKind.ALREADY };
  // A `vite: { ... }` block is an object literal, so our keys can go straight after the brace and
  // whatever is already in there is untouched. Refusing outright was the only genuine install defect
  // left in the gate: the config bailed while the LAYOUT patch applied anyway, leaving an app with a
  // connect snippet, no inlined token and no raised build target — which cannot connect, reported as
  // one OK step and one warning.
  const viteObject = VITE_OBJECT_KEY.exec(source);
  if (viteObject?.index !== undefined) {
    const at = viteObject.index + viteObject[0].length;
    const merged = mergeIntoViteBlock(source, at, config);
    if (merged !== null) {
      return {
        kind: PatchKind.APPLY,
        code: `${HELPER_IMPORTS}${merged.trimStart()}\n${HELPER}`.trimEnd() + '\n',
      };
    }
    return {
      kind: PatchKind.MANUAL,
      reason:
        'this config sets a `vite` key Reticle needs (build / optimizeDeps / define) to something ' +
        'other than an object literal — merging into it is your call, not a text edit Reticle should make',
    };
  }
  if (ANY_VITE_KEY.test(source)) {
    // `vite: sharedConfig` — not an object literal, so there is no brace to merge into and guessing
    // would corrupt a build config. The recipe is the honest answer here.
    return {
      kind: PatchKind.MANUAL,
      reason:
        'this config sets `vite:` to something other than an object literal — merging into it is your call, not a text edit Reticle should make',
    };
  }
  const opening = config.defineCall.exec(source);
  if (opening?.index === undefined) {
    return {
      kind: PatchKind.MANUAL,
      reason: "couldn't find a config call to extend",
    };
  }
  const at = opening.index + opening[0].length;
  const withBlock = `${source.slice(0, at)}\n${viteBlock(config)}${source.slice(at)}`;
  return {
    kind: PatchKind.APPLY,
    code: `${HELPER_IMPORTS}${withBlock.trimStart()}\n${HELPER}`.trimEnd() + '\n',
  };
}
