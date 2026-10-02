/**
 * The TanStack Start connect: a client-only component, rendered in the document the root route SSRs.
 *
 * Its own module because Start is the one framework whose document module is ALSO the server
 * render, so what may be written into it — and what must stay out — is a unit.
 */

import { posix } from 'node:path';
import { UiLibrary } from '@/detect/detect.js';
import {
  connectArg,
  devModuleSpecifier,
  sdkImport,
  UNVERIFIED_TANSTACK_START_NOTE,
} from './snippets.js';
import { PatchKind, type SourcePatch } from './patch-kind.js';
import { VITE_ENV_DEV_DECLARATION } from './vite-env-types.js';

/** TanStack Start's document module — the file that SSRs `<html>`. */
export const TANSTACK_START_ROOT_PATH = 'src/routes/__root.tsx';

/** The component `init` writes, and renders in the root document. */
const CONNECT_COMPONENT = 'ReticleConnect';
const CONNECT_FILE_BASENAME = 'reticle-connect';

/** `<Scripts />` — Start's own client-script outlet, which every root document has to render. */
const SCRIPTS_OUTLET = /^([ \t]*)<Scripts\s*\/>/m;

/**
 * Where the connect component goes: beside the `routes/` directory, never inside it — a file under
 * `routes/` is a route to Start's file-based router.
 */
export function tanstackStartConnectPath(rootPath: string = TANSTACK_START_ROOT_PATH): string {
  return posix.join(posix.dirname(posix.dirname(rootPath)), `${CONNECT_FILE_BASENAME}.tsx`);
}

/**
 * The connect component.
 *
 * A dynamic SDK import inside `useEffect`, because a static import on anything the root document
 * imports is evaluated during the server render and 500s the page. Effects never run on the server.
 * The pairing token is the one the Vite plugin inlines as `__RETICLE_TOKEN__`, declared here so the
 * file passes the scaffold's strict `tsc` — the recipe this replaced used the name undeclared and
 * failed with `TS2304: Cannot find name '__RETICLE_TOKEN__'`.
 *
 * It also loads the app's `src/reticle-dev.ts` after connecting. Start is written `inject: false`,
 * and the plugin's injected connect is the only other thing that imports that file, so without this
 * line every store and capability registered there silently never ran.
 */
export function tanstackStartConnectFile(
  port: number | undefined,
  projectId?: string,
  rootPath: string = TANSTACK_START_ROOT_PATH,
): string {
  const sdk = sdkImport(UiLibrary.REACT);
  const base = connectArg(port, projectId);
  const fields = '' === base ? '' : `${base.slice(1, -1).trim()}, `;
  const imports = sdk.usesInstall ? 'reticle, install' : 'reticle';
  const installLine = sdk.usesInstall
    ? '      install();'
    : '      // No React adapter here: the sensor has no install() to call.';
  const devModule = devModuleSpecifier(tanstackStartConnectPath(rootPath));
  return `import { useEffect } from 'react';

/**
 * Dev-only: connect Reticle from the client. Start SSRs its own <html> and never sends Vite's
 * index.html, so the plugin's injection cannot do it. Rendered once in the root document.
 */
export function ${CONNECT_COMPONENT}() {
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    // Inlined by @reticlehq/vite-plugin. The bridge refuses a connect without it, even on localhost.
    const token = typeof __RETICLE_TOKEN__ !== 'undefined' ? __RETICLE_TOKEN__ : '';
    const root = typeof __RETICLE_ROOT__ !== 'undefined' ? __RETICLE_ROOT__ : '';
    void import('${sdk.specifier}').then(({ ${imports} }) => {
${installLine}
      reticle.connect({
        ${fields}...(token.length > 0 ? { token } : {}),
        ...(root.length > 0 ? { root } : {}),
      });
      // Your stores and capabilities live here; nothing else loads this file under Start.
      void import('${devModule}');
    });
  }, []);
  return null;
}

declare const __RETICLE_TOKEN__: string | undefined;
declare const __RETICLE_ROOT__: string | undefined;

${VITE_ENV_DEV_DECLARATION}`;
}

/** The import the root document gets, relative to where it lives. */
function connectImport(rootPath: string): string {
  const target = tanstackStartConnectPath(rootPath).replace(/\.tsx$/, '');
  const rel = posix.relative(posix.dirname(rootPath), target);
  return `import { ${CONNECT_COMPONENT} } from '${rel.startsWith('.') ? rel : `./${rel}`}';`;
}

/**
 * Render the component in the root document, just before `<Scripts />`.
 *
 * `<Scripts />` is the anchor because every Start root has to render it — it is how the client
 * bundle reaches the page — whatever the component around it is called (`RootDocument` as the
 * route's `shellComponent` in the current template; `RootComponent` in older ones). A root without
 * one is a shape we do not recognise, and a half-edited document is worse than a documented step.
 */
export function patchTanstackStartRoot(source: string, rootPath: string): SourcePatch {
  if (source.includes(CONNECT_COMPONENT)) return { kind: PatchKind.ALREADY };
  if (!rootPath.endsWith('.tsx')) {
    return { kind: PatchKind.MANUAL, reason: `${rootPath} is not TypeScript` };
  }
  const outlet = SCRIPTS_OUTLET.exec(source);
  if (null === outlet) {
    return { kind: PatchKind.MANUAL, reason: `no <Scripts /> found in ${rootPath}` };
  }
  const indent = outlet[1] ?? '';
  const rendered = source.replace(SCRIPTS_OUTLET, `${indent}<${CONNECT_COMPONENT} />\n$&`);
  const lines = rendered.split('\n');
  let lastImport = -1;
  for (const [index, line] of lines.entries()) {
    if (/^import\s/.test(line)) lastImport = index;
  }
  lines.splice(lastImport + 1, 0, connectImport(rootPath));
  return { kind: PatchKind.APPLY, code: lines.join('\n') };
}

/**
 * The recipe, for a root `patchTanstackStartRoot` would not edit.
 *
 * The same two edits it makes, stated as edits: create the component, render it before
 * `<Scripts />`. It used to say "add this useEffect to the App component", naming a component the
 * current template does not have, and its snippet used `__RETICLE_TOKEN__` undeclared.
 */
export function tanstackStartManual(
  port: number | undefined,
  projectId?: string,
  rootPath: string = TANSTACK_START_ROOT_PATH,
): string {
  const component = tanstackStartConnectFile(port, projectId, rootPath)
    .split('\n')
    .map((line) => (0 === line.length ? line : `      ${line}`))
    .join('\n');
  return `TanStack Start SSRs <html> from ${rootPath} (HeadContent / Scripts) and never sends Vite's
  index.html, so the plugin's connect injection never fires. Keep the plugin anyway, with
  reticle({ inject: false }): only the injection half is inapplicable, and the stamping half is
  what puts data-reticle-source on the JSX. Dropping the plugin because one of its two jobs did
  not apply is how Remix lost file:line.

  1. Create ${tanstackStartConnectPath(rootPath)}. It connects from a CLIENT-ONLY effect: a static SDK
     import on anything the root document imports SSRs and 500s.
     Do not guard on window.location.hostname === 'localhost' — import.meta.env.DEV is the correct
     guard, and it does not care what host you develop on.

${component}
  2. In ${rootPath}, add \`${connectImport(rootPath)}\` and render <${CONNECT_COMPONENT} /> in the
     component that renders <html> (the route's shellComponent), just before <Scripts />.

  The plugin inlines __RETICLE_TOKEN__ when Vite resolves its config. Start the daemon BEFORE the
  dev server so that file exists; a server that started first froze an empty token and the page
  looks like it "won't dial". Restart after init, and after the daemon is up.

  ${UNVERIFIED_TANSTACK_START_NOTE}`;
}
