/**
 * Remix v2's client entry, and the one honest answer for the classic compiler.
 *
 * Remix on Vite is React Router framework mode under its old name: it SSRs its own HTML, so the
 * Vite plugin's `index.html` injection never reaches the page, and the connect has to come from
 * `app/entry.client.tsx` — the same line, the same file, verified by hand to connect.
 */

import { REACT_ROUTER_CONNECT_LINE } from './snippets.js';

/**
 * The client entry `init` writes when a Remix app has none.
 *
 * Like React Router's, `app/entry.client.tsx` is an OVERRIDE of a default Remix supplies — it only
 * exists once somebody runs `remix reveal`. So the written file has to hydrate as well as connect:
 * one holding only our import would replace the default with an app that renders nothing. This is
 * Remix v2's own default entry with one line added.
 */
export function remixEntryFile(): string {
  return `import { RemixBrowser } from '@remix-run/react';
import { startTransition, StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';

// Dev-only: Remix renders HTML through its own request handler, so the Vite plugin's index.html
// injection never fires and the connect script never reaches the page. The plugin is still doing
// the other half of the job — it stamps data-reticle-source, which puts file:line on every verdict.
${REACT_ROUTER_CONNECT_LINE}

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <RemixBrowser />
    </StrictMode>,
  );
});
`;
}

/**
 * The classic compiler has no Vite, so nothing serves `/@reticle-connect` and nothing stamps source.
 *
 * Said plainly and left as a ⚠ rather than papered over: writing the entry line here would import a
 * module no dev server serves, and the app would log a failed import on every page load instead of
 * connecting.
 */
export const REMIX_CLASSIC_MANUAL = `This is Remix on the classic compiler (remix.config.js, no Vite), and Reticle cannot wire it:
the connect module and the source stamping both come from @reticlehq/vite-plugin, and this build
never runs Vite.

  • Recommended: move to Remix's Vite plugin (https://remix.run/docs/en/main/guides/vite), or on to
    React Router v7+ framework mode, then re-run \`reticle init\` — both are wired automatically.
  • Or connect by hand from app/entry.client.tsx, dev-only, through the React kit init installed:

      if (process.env.NODE_ENV === 'development') {
        void import('@reticlehq/react').then(({ reticle, install }) => {
          install();
          reticle.connect({ token: '<the contents of ~/.reticle/pairing-token>' });
        });
      }

    The token is per-machine: keep it out of version control.`;
