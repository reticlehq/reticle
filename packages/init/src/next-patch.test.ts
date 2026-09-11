import { describe, it, expect } from 'vitest';
import {
  patchNextConfig,
  patchRootLayout,
  patchPagesApp,
  reticleDevLocation,
} from './next-patch.js';
import { PatchKind } from './patch-kind.js';

/**
 * Next was the only stack `init` left with TWO hand edits, and one of them is a JSX edit inside the
 * root layout — the exact thing the people this is built for cannot do. Skipping either fails
 * SILENTLY: the app boots, nothing connects, and no message says why. These pin the auto-patch.
 */
describe('patchNextConfig', () => {
  const ESM = `import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default nextConfig;
`;

  it('wraps an ESM default export and adds the import', () => {
    const r = patchNextConfig(ESM);
    expect(r.kind).toBe(PatchKind.APPLY);
    if (r.kind !== PatchKind.APPLY) return;
    expect(r.code).toContain("import { withReticle } from '@reticlehq/next';");
    expect(r.code).toContain('export default withReticle(nextConfig);');
  });

  it('wraps an inline object default export', () => {
    const r = patchNextConfig('export default { reactStrictMode: true };\n');
    expect(r.kind).toBe(PatchKind.APPLY);
    if (r.kind !== PatchKind.APPLY) return;
    expect(r.code).toContain('export default withReticle({ reactStrictMode: true });');
  });

  it('wraps a CommonJS module.exports with a require, not an import', () => {
    const r = patchNextConfig('const nextConfig = {};\nmodule.exports = nextConfig;\n');
    expect(r.kind).toBe(PatchKind.APPLY);
    if (r.kind !== PatchKind.APPLY) return;
    expect(r.code).toContain("const { withReticle } = require('@reticlehq/next');");
    expect(r.code).toContain('module.exports = withReticle(nextConfig);');
    expect(r.code).not.toContain('import {');
  });

  it('is idempotent — a config already wrapped is left alone', () => {
    const once = patchNextConfig(ESM);
    if (once.kind !== PatchKind.APPLY) throw new Error('expected apply');
    expect(patchNextConfig(once.code).kind).toBe(PatchKind.ALREADY);
  });

  it('bails to manual rather than half-editing a config it does not recognise', () => {
    const r = patchNextConfig('const nextConfig = {};\n');
    expect(r.kind).toBe(PatchKind.MANUAL);
  });

  /**
   * The shape that broke a real app. The old pattern ran from `module.exports =` to END OF FILE, so
   * on a config that exports conditionally it captured the first assignment AND everything after it
   * — the else-branch, the closing brace, all of it — and emitted
   *
   *     module.exports = withReticle(withSentryConfig(nextConfig, sentryConfig);
   *     } else {
   *       module.exports = nextConfig;
   *     });
   *
   * an unbalanced-paren SYNTAX ERROR. `next dev` exited 1, the gate reported only "dev server never
   * served", and `init` had reported the step as ✓.
   *
   * Both branches get wrapped, because which one runs is an env var's business: the result is
   * correct whichever executes, and the app connects instead of landing on a manual step.
   */
  it('wraps both branches of a conditional export', () => {
    const source = `const nextConfig = {};
if (process.env.SENTRY) {
  module.exports = withSentryConfig(nextConfig, sentryConfig);
} else {
  module.exports = nextConfig;
}
`;
    const r = patchNextConfig(source);
    expect(r.kind).toBe(PatchKind.APPLY);
    if (r.kind !== PatchKind.APPLY) return;
    expect(r.code).toContain(
      'module.exports = withReticle(withSentryConfig(nextConfig, sentryConfig));',
    );
    expect(r.code).toContain('module.exports = withReticle(nextConfig);');
    // The braces must still balance — the whole point.
    const opens = (r.code.match(/\(/g) ?? []).length;
    const closes = (r.code.match(/\)/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  /** Same root cause, single export: anything AFTER the export used to be swallowed into the wrap. */
  it('wraps only the exported expression when code follows the export', () => {
    const source = `const nextConfig = {};
module.exports = withSentryConfig(nextConfig, sentryConfig);

// a trailing statement the old pattern swallowed into the wrap
process.on('exit', () => undefined);
`;
    const r = patchNextConfig(source);
    expect(r.kind).toBe(PatchKind.APPLY);
    if (r.kind !== PatchKind.APPLY) return;
    expect(r.code).toContain(
      'module.exports = withReticle(withSentryConfig(nextConfig, sentryConfig));',
    );
    expect(r.code).toContain("process.on('exit', () => undefined);");
  });

  /** A multi-line inline object must be wrapped whole — the brace depth is what ends the expression. */
  it('wraps a multi-line inline object export', () => {
    const source = `export default {
  reactStrictMode: true,
  images: { unoptimized: true },
};
`;
    const r = patchNextConfig(source);
    expect(r.kind).toBe(PatchKind.APPLY);
    if (r.kind !== PatchKind.APPLY) return;
    expect(r.code).toContain('export default withReticle({');
    expect(r.code).toContain('});');
  });
});

describe('patchRootLayout', () => {
  const LAYOUT = `import type { Metadata } from "next";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="x">{children}</body>
    </html>
  );
}
`;

  it('mounts ReticleDev inside <body> behind a dev guard, and adds the import', () => {
    const r = patchRootLayout(LAYOUT);
    expect(r.kind).toBe(PatchKind.APPLY);
    if (r.kind !== PatchKind.APPLY) return;
    expect(r.code).toContain("import { ReticleDev } from './reticle-dev';");
    expect(r.code).toContain(
      '<body className="x">{process.env.NODE_ENV === \'development\' ? <ReticleDev /> : null}{children}</body>',
    );
  });

  it('handles a bare <body> with no attributes', () => {
    const r = patchRootLayout('export default function L(){return <html><body>{c}</body></html>}');
    expect(r.kind).toBe(PatchKind.APPLY);
    if (r.kind !== PatchKind.APPLY) return;
    expect(r.code).toContain('<body>{process.env');
  });

  it('is idempotent', () => {
    const once = patchRootLayout(LAYOUT);
    if (once.kind !== PatchKind.APPLY) throw new Error('expected apply');
    expect(patchRootLayout(once.code).kind).toBe(PatchKind.ALREADY);
  });

  /**
   * A Pages Router app has no `app/layout.tsx` at all, so the layout patch has nothing to find and
   * the connect has to mount through `pages/_app`. Without this, `init` wrote a component to a
   * directory that does not exist and the app connected to nothing, silently.
   */
  it('imports the component from wherever it was written, not a fixed sibling path', () => {
    const APP =
      'export default function App({ Component, pageProps }) {\n  return <Component {...pageProps} />;\n}\n';
    const r = patchPagesApp(APP, '../components/reticle-dev');
    if (r.kind !== PatchKind.APPLY) throw new Error('expected apply');
    expect(r.code).toContain("import { ReticleDev } from '../components/reticle-dev';");
  });

  it('mounts around the page component when handed a pages/_app', () => {
    const APP = `import type { AppProps } from 'next/app';
export default function App({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}
`;
    const r = patchPagesApp(APP);
    expect(r.kind).toBe(PatchKind.APPLY);
    if (r.kind !== PatchKind.APPLY) return;
    expect(r.code).toContain("import { ReticleDev } from './reticle-dev';");
    expect(r.code).toContain('<>');
    expect(r.code).toContain("{process.env.NODE_ENV === 'development' ? <ReticleDev /> : null}");
    expect(r.code).toContain('<Component {...pageProps} />');
  });

  it('pages/_app patch is idempotent and bails when there is no <Component .../>', () => {
    const APP =
      'export default function App({ Component, pageProps }) {\n  return <Component {...pageProps} />;\n}\n';
    const once = patchPagesApp(APP);
    if (once.kind !== PatchKind.APPLY) throw new Error('expected apply');
    expect(patchPagesApp(once.code).kind).toBe(PatchKind.ALREADY);
    expect(patchPagesApp('export default () => null;').kind).toBe(PatchKind.MANUAL);
  });

  it('bails to manual when there is no <body>, or more than one', () => {
    expect(patchRootLayout('export default () => <div/>;').kind).toBe(PatchKind.MANUAL);
    // Two <body> tags mean we cannot tell which one renders — a wrong guess mounts nothing.
    expect(patchRootLayout('<body>a</body><body>b</body>').kind).toBe(PatchKind.MANUAL);
  });
});

/**
 * Where the connect component is WRITTEN is not cosmetic on Pages Router.
 *
 * Every file under `pages/` is a route. A component dropped there has no default export, so
 * `/reticle-dev` 500s and `next build` fails — and the extension matters just as much: a `.tsx` file
 * in a JavaScript project makes Next auto-install TypeScript on the next `next dev`, which on Next 13
 * takes its require-hook down with it and the dev server never starts at all. Both were shipped by
 * one line choosing a hardcoded path.
 */
describe('reticleDevLocation', () => {
  it('keeps the component OUT of the pages route directory', () => {
    const loc = reticleDevLocation('pages/_app.js', false);
    expect(loc.path).toBe('components/reticle-dev.jsx');
    expect(loc.path.startsWith('pages/')).toBe(false);
    expect(loc.importSpecifier).toBe('../components/reticle-dev');
  });

  it('respects a src/ layout on both sides', () => {
    const loc = reticleDevLocation('src/pages/_app.tsx', true);
    expect(loc.path).toBe('src/components/reticle-dev.tsx');
    expect(loc.importSpecifier).toBe('../components/reticle-dev');
  });

  it('writes .jsx into a JavaScript project — a stray .tsx makes Next install TypeScript', () => {
    expect(reticleDevLocation('pages/_app.js', false).path.endsWith('.jsx')).toBe(true);
    expect(reticleDevLocation('pages/_app.tsx', true).path.endsWith('.tsx')).toBe(true);
  });

  it('App Router keeps the component beside the layout — app/ routes on filename, not presence', () => {
    expect(reticleDevLocation('app/layout.tsx', true)).toEqual({
      path: 'app/reticle-dev.tsx',
      importSpecifier: './reticle-dev',
    });
    expect(reticleDevLocation('src/app/layout.jsx', false).path).toBe('src/app/reticle-dev.jsx');
  });
});
