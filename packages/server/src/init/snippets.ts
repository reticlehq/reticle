/**
 * Generated file contents and copy-paste snippets for `iris init`. Kept as named constants so the
 * runner never inlines free strings (see dev-skills/conventions.md).
 */

/** The Vite-config snippet printed when we can't safely auto-patch the config. */
export const VITE_MANUAL = `Add the Iris plugin to your Vite config:

  import { iris } from '@syrin/iris/vite';

  export default defineConfig({
    plugins: [react(), iris()],
  });

The plugin only applies during \`vite\` (dev) — it is dropped from \`vite build\`.`;

/** Next.js config wrap — always printed (we never auto-rewrite next.config). */
export function nextConfigManual(configFile: string): string {
  return `Wrap your ${configFile} export with withIris (keeps SWC, dev-only):

  import { withIris } from '@syrin/iris/next';

  export default withIris(nextConfig);`;
}

/** The dev-only client component that connects Iris after hydration. */
export const NEXT_IRIS_DEV_FILE = `'use client';
import { useEffect } from 'react';

/** Dev-only: connect Iris + install the React adapter, after hydration. */
export function IrisDev() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    void import('@syrin/iris').then(({ iris, install }) => {
      install();
      iris.connect();
    });
  }, []);
  return null;
}
`;

/** Mount instruction for the root layout. */
export const NEXT_LAYOUT_MANUAL = `Mount <IrisDev /> in your root layout (app/layout.tsx), dev-only:

  import { IrisDev } from './iris-dev';
  // inside <body>:
  {process.env.NODE_ENV === 'development' ? <IrisDev /> : null}`;

/** Plain-HTML / vanilla connect snippet. */
export const HTML_MANUAL = `Add a dev-gated module script at app boot:

  <script type="module">
    if (location.hostname === 'localhost') {
      const { iris, install } = await import('@syrin/iris');
      install();
      iris.connect();
    }
  </script>`;

export const NEXT_IRIS_DEV_PATH = 'app/iris-dev.tsx';
