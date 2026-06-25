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

/** Plain-HTML / vanilla connect snippet. */
export function htmlManual(port: number | undefined, projectId?: string): string {
  return `Add a dev-gated module script at app boot:

  <script type="module">
    if (location.hostname === 'localhost') {
      const { iris, install } = await import('@syrin/iris');
      install();
      iris.connect(${connectArg(port, projectId)});
    }
  </script>`;
}

export const NEXT_IRIS_DEV_PATH = 'app/iris-dev.tsx';

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
