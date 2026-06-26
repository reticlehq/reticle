/**
 * Generated file contents and copy-paste snippets for `iris init`. Kept as named constants/builders
 * so the runner never inlines free strings.
 */

import { IRIS_DEFAULT_PORT, IRIS_WS_PATH } from '@syrin/iris-protocol';

/**
 * The connect() argument literal: a non-default port adds a `url`, and a projectId is always passed
 * (so the app is identifiable across port changes). Empty string only when neither applies.
 */
function connectArg(port: number | undefined, projectId?: string): string {
  const parts: string[] = [];
  if (port !== undefined && port !== IRIS_DEFAULT_PORT) {
    parts.push(`url: 'ws://localhost:${String(port)}${IRIS_WS_PATH}'`);
  }
  if (projectId !== undefined && projectId.length > 0) parts.push(`projectId: '${projectId}'`);
  return parts.length > 0 ? `{ ${parts.join(', ')} }` : '';
}

/** The Vite-config snippet printed when we can't safely auto-patch the config. */
export function viteManual(port: number | undefined): string {
  const call = port === undefined ? 'iris()' : `iris({ port: ${String(port)} })`;
  return `Add the Iris plugin to your Vite config:

  import { iris } from '@syrin/iris/vite';

  export default defineConfig({
    plugins: [react(), ${call}],
  });

The plugin only applies during \`vite\` (dev) — it is dropped from \`vite build\`.`;
}

/** Next.js config wrap — always printed (we never auto-rewrite next.config). */
export function nextConfigManual(configFile: string): string {
  return `Wrap your ${configFile} export with withIris (keeps SWC, dev-only):

  import { withIris } from '@syrin/iris/next';

  export default withIris(nextConfig);`;
}

/** The dev-only client component that connects Iris after hydration. */
export function nextIrisDevFile(port: number | undefined, projectId?: string): string {
  return `'use client';
import { useEffect } from 'react';

/** Dev-only: connect Iris + install the React adapter, after hydration. */
export function IrisDev() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    void import('@syrin/iris').then(({ iris, install }) => {
      install();
      iris.connect(${connectArg(port, projectId)});
    });
  }, []);
  return null;
}
`;
}

/** Mount instruction for the root layout. */
export const NEXT_LAYOUT_MANUAL = `Mount <IrisDev /> in your root layout (app/layout.tsx), dev-only:

  import { IrisDev } from './iris-dev';
  // inside <body>:
  {process.env.NODE_ENV === 'development' ? <IrisDev /> : null}`;

/**
 * Manual connect guidance for projects without a Vite/Next plugin. Most such projects still use a
 * BUNDLER (CRA, webpack, Parcel, Vue/Svelte CLIs) — for those, the connect goes in the entry MODULE,
 * where a bare `@syrin/iris` import resolves. A bare import in a plain index.html does NOT resolve in
 * the browser, so we never tell a bundled app to do that (the old advice silently failed for CRA).
 */
export function htmlManual(port: number | undefined, projectId?: string): string {
  const arg = connectArg(port, projectId);
  return `No Vite/Next plugin detected — wire the dev-only connect by hand. Pick the form for your setup:

  • Bundled app (Create React App, webpack, Parcel, Vue/Svelte CLI, etc.) — add to your ENTRY module
    (e.g. src/index.js or src/main.js), where '@syrin/iris' resolves through your bundler:

      if (location.hostname === 'localhost') {
        const { iris, install } = await import('@syrin/iris');
        install();
        iris.connect(${arg});
      }

  • Plain static HTML with no build step — the browser can't resolve the bare '@syrin/iris' import, so
    bundle the SDK once (e.g. \`npx esbuild\`) and point a dev-only <script type="module"> at the output,
    or serve the page through a dev server (Vite) that resolves bare imports.`;
}

export const NEXT_IRIS_DEV_PATH = 'app/iris-dev.tsx';
export const SVELTEKIT_HOOKS_PATH = 'src/hooks.client.ts';

/**
 * Dev-only client hook that connects Iris in a SvelteKit app. SvelteKit renders through app.html and
 * never triggers Vite's index.html injection (verified), so the standard plugin can't auto-connect —
 * a client hook is the reliable path. SvelteKit runs src/hooks.client.ts on the client at startup.
 */
export function svelteKitHooksFile(port: number | undefined, projectId?: string): string {
  return `// Dev-only: connect Iris on the client. SvelteKit renders via app.html, so the Vite-plugin
// index.html injection doesn't fire — connect from this client hook instead.
if (import.meta.env.DEV) {
  void import('@syrin/iris').then(({ iris, install }) => {
    install();
    iris.connect(${connectArg(port, projectId)});
  });
}
`;
}

/**
 * Root-level project config for Syrin Iris. Written by `iris init`; read by `iris mcp` for the port
 * and by tooling for the stable projectId (the app's identity across port changes).
 */
export function irisConfigContent(
  framework: string,
  port: number | undefined,
  projectId?: string,
): string {
  const fields: Record<string, unknown> = { framework };
  if (projectId !== undefined && projectId.length > 0) fields['projectId'] = projectId;
  if (port !== undefined && port !== IRIS_DEFAULT_PORT) fields['port'] = port;
  return `${JSON.stringify(fields, null, 2)}\n`;
}
