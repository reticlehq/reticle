/**
 * The TanStack Start connect recipe.
 *
 * Its own module rather than another entry in `snippets.ts`, which was at the 1000-line backstop:
 * Start is the one framework whose document module `init` deliberately refuses to write, so the
 * recipe and the reasoning behind that refusal are a unit.
 */

import { UiLibrary } from './detect.js';
import { connectArg, sdkImport, UNVERIFIED_TANSTACK_START_NOTE } from './snippets.js';

/** TanStack Start's document module — the file that SSRs `<html>`. */
export const TANSTACK_START_ROOT_PATH = 'src/routes/__root.tsx';

/**
 * The TanStack Start recipe, printed rather than written.
 *
 * `__root.tsx` is the document. A static import of the SDK on that module SSRs and 500s, so `init`
 * does not write one. The connect has to be a client-only dynamic import inside `useEffect`, with
 * the pairing token the plugin inlines as `__RETICLE_TOKEN__`. Same judgement React Router already
 * makes about `app/entry.client.tsx`: a half-written document is worse than a documented manual step.
 */
export function tanstackStartManual(
  port: number | undefined,
  projectId?: string,
  rootPath: string = TANSTACK_START_ROOT_PATH,
): string {
  const sdk = sdkImport(UiLibrary.REACT);
  const base = connectArg(port, projectId);
  const fields = '' === base ? '' : `${base.slice(1, -1).trim()}, `;
  const installLine = sdk.usesInstall
    ? '        install();'
    : '        // No React adapter here: the sensor has no install() to call.';
  const imports = sdk.usesInstall ? 'reticle, install' : 'reticle';
  return `TanStack Start SSRs <html> from ${rootPath} (HeadContent / Scripts) and never sends Vite's
  index.html, so the plugin's connect injection never fires. Keep the plugin anyway, with
  reticle({ inject: false }): only the injection half is inapplicable, and the stamping half is
  what puts data-reticle-source on the JSX. Dropping the plugin because one of its two jobs did
  not apply is how Remix lost file:line.

  Connect from a CLIENT-ONLY effect in ${rootPath}. A static SDK import on that module SSRs and
  500s. Do not guard on window.location.hostname === 'localhost' — import.meta.env.DEV is the
  correct guard, and it does not care what host you develop on.

  Add this useEffect to the App component (import useEffect from react if it is not already there):

      useEffect(() => {
        if (import.meta.env.DEV) {
          const token = typeof __RETICLE_TOKEN__ !== 'undefined' ? __RETICLE_TOKEN__ : '';
          void import('${sdk.specifier}').then(({ ${imports} }) => {
${installLine}
            reticle.connect({
              ${fields}...(token.length > 0 ? { token } : {}),
            });
          });
        }
      }, []);

  The plugin inlines __RETICLE_TOKEN__ when Vite resolves its config. Start the daemon BEFORE the
  dev server so that file exists; a server that started first froze an empty token and the page
  looks like it "won't dial". Restart after init, and after the daemon is up.

  ${UNVERIFIED_TANSTACK_START_NOTE}`;
}
