import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import { reticle } from '@reticlehq/vite-plugin';

// The plugin is wired with `inject: false`. Astro SSRs its own HTML, so the connect-injection
// never fires; the STAMPING half is what puts data-reticle-source on the JSX.
//
// The pairing token is NOT inlined here. On Astro 7.2+ `vite.define` does not reach the client
// pipeline (#1008): the served page script still contains the literal `__RETICLE_TOKEN__`, so
// `connect()` omits the token and the bridge refuses the dial. The page reads the file in frontmatter
// instead and puts it on a <meta> a processed <script> queries, which also means a token written
// AFTER the dev server started is picked up on the next request rather than needing a restart.
//
// `vite.build.target` is bumped to es2022 so Astro doesn't try to down-level the modern
// @reticlehq/react bundle to its conservative default browser target.
// `optimizeDeps.include` warms the SDK before the first page load (no esbuildOptions: Vite 8 /
// Rolldown dropped that key).
export default defineConfig({
  integrations: [react()],
  server: { port: 5304 },
  vite: {
    /* reticle-vite-owning */
    build: { target: 'es2022' },
    optimizeDeps: { include: ['@reticlehq/react'] },
    plugins: [reticle({ inject: false })],
    // strictPort so a squatter on 5304 is a hard, named startup error instead of a silent move to the
    // next free port, which serves the e2e harness someone else's 404 and looks like a broken connect.
    server: { strictPort: true, watch: { ignored: [/(^|[\\/])\.reticle([\\/]|$)/] } },
  },
});
