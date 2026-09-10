/**
 * Pure, conservative patchers for the two files a Next app needed edited BY HAND: `next.config.*`
 * (wrap the export in `withReticle`) and `app/layout.tsx` (mount `<ReticleDev />`). Same contract as
 * the Vite patcher — recognise the obvious shape, bail to `manual` on anything ambiguous, never
 * half-edit. Leaving these manual is why Next connected 0% of the time: both edits are silent when
 * skipped, and one of them is JSX.
 */

import { PatchKind, type SourcePatch } from './patch-kind.js';

const RETICLE_NEXT_PACKAGE = '@reticlehq/next';
const NEXT_CONFIG_IMPORT = `import { withReticle } from '${RETICLE_NEXT_PACKAGE}';`;
const NEXT_CONFIG_REQUIRE = `const { withReticle } = require('${RETICLE_NEXT_PACKAGE}');`;

const RETICLE_DEV_COMPONENT = 'ReticleDev';
const RETICLE_DEV_BASENAME = 'reticle-dev';
/** Default import specifier: the component sits beside the file importing it (App Router). */
const RETICLE_DEV_SIBLING = `./${RETICLE_DEV_BASENAME}`;
const reticleDevImport = (specifier: string): string =>
  `import { ${RETICLE_DEV_COMPONENT} } from '${specifier}';`;
const RETICLE_DEV_IMPORT = reticleDevImport(RETICLE_DEV_SIBLING);

/** Where the generated connect component goes, and how the mount file should import it. */
interface ReticleDevLocation {
  /** Project-relative path to write. */
  path: string;
  /** What the mount file (`app/layout.*` or `pages/_app.*`) should import. */
  importSpecifier: string;
}

/**
 * Decide where the connect component lives, from the file that will mount it.
 *
 * Two things this gets wrong if hardcoded, both of which broke real apps:
 *
 * - **Pages Router routes on presence.** EVERY file under `pages/` is a route, so a component
 *   dropped there has no default export: `/reticle-dev` 500s and `next build` fails. It has to go
 *   somewhere that is not a route directory. App Router routes on FILENAME (`page`/`layout`/
 *   `route`), so an extra file beside the layout is inert and can stay there.
 * - **The extension is not cosmetic.** A `.tsx` file in a JavaScript project makes Next auto-install
 *   TypeScript on the next `next dev` — and on Next 13 that takes its require-hook down with it, so
 *   the dev server never starts. The install then looks like it broke the app, because it did.
 */
export function reticleDevLocation(mountPath: string, typescript: boolean): ReticleDevLocation {
  const ext = typescript ? '.tsx' : '.jsx';
  const slash = mountPath.lastIndexOf('/');
  const dir = -1 === slash ? '' : mountPath.slice(0, slash);
  const isPagesRouter = /(^|\/)pages$/.test(dir);
  if (!isPagesRouter) {
    return {
      path: `${'' === dir ? '' : `${dir}/`}${RETICLE_DEV_BASENAME}${ext}`,
      importSpecifier: RETICLE_DEV_SIBLING,
    };
  }
  // Siblings of `pages/`, so `src/pages/_app.js` → `src/components/…` and `pages/_app.js` → `components/…`.
  const parent = dir.slice(0, Math.max(0, dir.length - 'pages'.length));
  return {
    path: `${parent}components/${RETICLE_DEV_BASENAME}${ext}`,
    importSpecifier: `../components/${RETICLE_DEV_BASENAME}`,
  };
}
/** The dev-guarded mount. Production strips it — `process.env.NODE_ENV` is inlined at build time. */
const RETICLE_DEV_MOUNT = `{process.env.NODE_ENV === 'development' ? <${RETICLE_DEV_COMPONENT} /> : null}`;

/**
 * `export default ` / `module.exports = ` at the START of a line — the head of the assignment, not
 * the whole statement. Where the exported expression ENDS is decided by `expressionEnd` below.
 *
 * These used to be `/…([\s\S]+?);?\s*$/`, which reads as "the expression, lazily". It is not: with
 * no `m` flag the `$` is end-of-FILE and the trailing `;?\s*` is satisfiable only there, so the
 * capture always ran to the last non-blank character of the file. Every config whose export was not
 * the final statement got everything after it swallowed into the wrap. On a config exporting
 * conditionally that produced an unbalanced paren — a syntax error, so `next dev` exited 1 while
 * `init` reported the step as ✓ and the only symptom was "dev server never served".
 */
const ESM_DEFAULT_HEAD = /^[ \t]*export[ \t]+default[ \t]+/gm;
const CJS_EXPORT_HEAD = /^[ \t]*module\.exports[ \t]*=[ \t]*/gm;
/** The opening `<body ...>` tag, whose first child is where the mount goes. */
const BODY_OPEN_TAG = /<body(\s[^>]*)?>/g;

const NO_EXPORT_REASON = "couldn't find an `export default` or `module.exports` to wrap";
const NO_BODY_REASON = "couldn't find a single <body> tag to mount <ReticleDev /> inside";

/** Bracket pairs that keep an expression open. A `;` at depth 0 is what ends it. */
const OPENERS = '([{';
const CLOSERS = ')]}';
const LINE_COMMENT = '//';
const BLOCK_COMMENT_OPEN = '/*';
const BLOCK_COMMENT_CLOSE = '*/';
const QUOTES = '\'"`';

/**
 * Index just past the exported expression that starts at `from` — the `;` that closes it, or end of
 * file. Tracks bracket depth so a multi-line object or a nested call ends in the right place, and
 * skips strings and comments so a `;` or a brace inside one cannot end it early.
 *
 * Deliberately a scanner and not a parser: `next.config.*` is arbitrary JS and this file's contract
 * is to recognise the obvious shape or bail. It only has to be right about where ONE expression
 * stops, and wrong is caught by the caller bailing to manual, never by a half-edit.
 */
function expressionEnd(source: string, from: number): number {
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    const ch = source[i] ?? '';
    const pair = source.slice(i, i + 2);
    if (pair === LINE_COMMENT) {
      const nl = source.indexOf('\n', i);
      if (-1 === nl) return source.length;
      i = nl;
      continue;
    }
    if (pair === BLOCK_COMMENT_OPEN) {
      const close = source.indexOf(BLOCK_COMMENT_CLOSE, i + 2);
      i = -1 === close ? source.length : close + 1;
      continue;
    }
    if (QUOTES.includes(ch)) {
      for (i++; i < source.length; i++) {
        if ('\\' === source[i]) i++;
        else if (source[i] === ch) break;
      }
      continue;
    }
    if (OPENERS.includes(ch)) depth++;
    else if (CLOSERS.includes(ch)) {
      // A closer at depth 0 belongs to an enclosing block, so the expression ended before it.
      if (0 === depth) return i;
      depth--;
    } else if (';' === ch && 0 === depth) return i;
  }
  return source.length;
}

interface ExportSite {
  /** Index of the first character of the exported expression. */
  start: number;
  /** Index just past the expression (at its `;`, or end of file). */
  end: number;
}

/** Every top-level export assignment in the file, in source order. */
function exportSites(source: string, head: RegExp): ExportSite[] {
  const sites: ExportSite[] = [];
  for (const match of source.matchAll(head)) {
    if (match.index === undefined) continue;
    const start = match.index + match[0].length;
    sites.push({ start, end: expressionEnd(source, start) });
  }
  return sites;
}

/**
 * Wrap every listed expression in `withReticle(...)`, leaving every other byte of the file alone.
 *
 * All of them, not just the first: a config can export CONDITIONALLY — Sentry-wrapped in one branch,
 * plain in the other — and which branch runs is an environment variable's business, not ours.
 * Wrapping each assignment is correct whichever one executes, and it is what turns that shape from a
 * manual step (an app that boots and never connects) into a working install.
 *
 * Applied back-to-front so each splice leaves the earlier offsets valid.
 */
function wrapAll(source: string, sites: readonly ExportSite[], secondArg: string): string {
  let out = source;
  for (const site of [...sites].sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, site.start)}withReticle(${out.slice(site.start, site.end)}${secondArg})${out.slice(site.end)}`;
  }
  return out;
}

/**
 * The second argument to `withReticle`, or nothing at all.
 *
 * A Next app has no plugin call to carry `sourceMapping: false`, so the only place to say it is the
 * config wrap itself. Omitted entirely when the stamp stays on, because an install that appends
 * `, {}` to every config it touches is a diff against the user's file for no reason.
 */
function withReticleOptions(sourceMapping: boolean): string {
  return sourceMapping ? '' : ', { sourceMapping: false }';
}

export function patchNextConfig(source: string, sourceMapping = true): SourcePatch {
  if (source.includes(RETICLE_NEXT_PACKAGE)) return { kind: PatchKind.ALREADY };

  const options = withReticleOptions(sourceMapping);
  const esm = exportSites(source, ESM_DEFAULT_HEAD);
  if (esm.length > 0) {
    return {
      kind: PatchKind.APPLY,
      code: `${NEXT_CONFIG_IMPORT}\n${wrapAll(source, esm, options)}`,
    };
  }

  const cjs = exportSites(source, CJS_EXPORT_HEAD);
  if (cjs.length > 0) {
    return {
      kind: PatchKind.APPLY,
      code: `${NEXT_CONFIG_REQUIRE}\n${wrapAll(source, cjs, options)}`,
    };
  }

  return { kind: PatchKind.MANUAL, reason: NO_EXPORT_REASON };
}

/** `<Component {...pageProps} />` — the one element every `pages/_app` renders. */
const PAGES_APP_COMPONENT = /<Component\b[^>]*\/>/g;
const NO_PAGES_COMPONENT_REASON =
  "couldn't find a single <Component {...pageProps} /> to wrap in pages/_app";

/**
 * Pages Router has no root layout to mount into — `app/layout.tsx` does not exist — so the connect
 * rides in `pages/_app` instead, wrapped in a fragment alongside the page. Without this, `init`
 * wrote `app/reticle-dev.tsx` into a directory the app does not have and nothing ever connected,
 * with no error to say so.
 */
export function patchPagesApp(
  source: string,
  importSpecifier: string = RETICLE_DEV_SIBLING,
): SourcePatch {
  if (source.includes(RETICLE_DEV_COMPONENT)) return { kind: PatchKind.ALREADY };

  const matches = [...source.matchAll(PAGES_APP_COMPONENT)];
  const match = 1 === matches.length ? matches[0] : undefined;
  if (match?.index === undefined)
    return { kind: PatchKind.MANUAL, reason: NO_PAGES_COMPONENT_REASON };

  const wrapped = `<>${RETICLE_DEV_MOUNT}${match[0]}</>`;
  const code = source.slice(0, match.index) + wrapped + source.slice(match.index + match[0].length);
  return { kind: PatchKind.APPLY, code: `${reticleDevImport(importSpecifier)}\n${code}` };
}

export function patchRootLayout(source: string): SourcePatch {
  if (source.includes(RETICLE_DEV_COMPONENT)) return { kind: PatchKind.ALREADY };

  const tags = [...source.matchAll(BODY_OPEN_TAG)];
  // Exactly one <body> or we cannot tell which one actually renders — and mounting into the wrong
  // one is the same silent no-connect as not mounting at all.
  const tag = 1 === tags.length ? tags[0] : undefined;
  if (tag?.index === undefined) return { kind: PatchKind.MANUAL, reason: NO_BODY_REASON };

  const insertAt = tag.index + tag[0].length;
  const mounted = `${source.slice(0, insertAt)}${RETICLE_DEV_MOUNT}${source.slice(insertAt)}`;
  return { kind: PatchKind.APPLY, code: `${RETICLE_DEV_IMPORT}\n${mounted}` };
}
