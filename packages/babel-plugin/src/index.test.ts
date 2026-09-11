import { describe, it, expect } from 'vitest';
import { transformSync } from '@babel/core';
// The module IS the plugin function (module.exports = fn) — a default import resolves to it under
// vite/node CJS interop, exactly as Babel's require() does. No named exports on the CJS module.
import plugin from './index.js';

import { DATA_RETICLE_SOURCE_ATTR } from '@reticlehq/core/source-constants';

const SOURCE_ATTR = DATA_RETICLE_SOURCE_ATTR;

function transform(code: string, filename = 'src/Foo.tsx'): string {
  const out = transformSync(code, {
    filename,
    plugins: [plugin],
    parserOpts: { plugins: ['jsx', 'typescript'] },
    configFile: false,
    babelrc: false,
  });
  return out?.code ?? '';
}

describe('reticle babel plugin', () => {
  it('stamps host elements with data-reticle-source (file:line:col)', () => {
    const out = transform('const x = <button>Hi</button>;');
    expect(out).toContain(SOURCE_ATTR);
    expect(out).toMatch(/src\/Foo\.tsx:1:\d+/);
  });

  it('emits forward slashes on every OS, so a pointer is the same string everywhere', () => {
    // `path.relative` returns the platform separator. On Windows this stamped `src\Foo.tsx:1:10`,
    // which is the headline `file:line` in a form that matches nothing else Reticle emits.
    const out = transform('const x = <span>Hi</span>;', 'src/deep/Bar.tsx');
    expect(out).toContain('src/deep/Bar.tsx:1:');
    expect(out).not.toContain('\\');
  });

  it('does not stamp components', () => {
    const out = transform('const x = <App />;');
    expect(out).not.toContain(SOURCE_ATTR);
  });

  it('is idempotent (does not double-stamp)', () => {
    const out = transform(`const x = <div ${SOURCE_ATTR}="existing">x</div>;`);
    // Built from SOURCE_ATTR, not the literal. Hardcoded, this counts occurrences of a string the
    // plugin no longer stamps the moment core renames the constant — so a legitimate rename reddens
    // it while real plugin-core drift stays unasserted, which is the alarm pointing the wrong way.
    expect((out.match(new RegExp(SOURCE_ATTR, 'g')) ?? []).length).toBe(1);
  });

  describe('@reticle-ignore', () => {
    // Matching semantics follow `packages/server/src/init/init-opt-out.ts`: case-insensitive
    // token match with a `(?![\w-])` boundary, so `@reticle-ignored` does not count.

    it('skips stamping when the file starts with `// @reticle-ignore`', () => {
      const out = transform(`// @reticle-ignore\nconst x = <button>Hi</button>;`);
      expect(out).not.toContain(SOURCE_ATTR);
    });

    it('skips stamping even with leading whitespace before the comment', () => {
      const out = transform(`   // @reticle-ignore\nconst x = <button>Hi</button>;`);
      expect(out).not.toContain(SOURCE_ATTR);
    });

    it('skips stamping when the marker appears anywhere in the source (token match, not first-line-only)', () => {
      const out = transform(
        `import React from 'react';\n// @reticle-ignore\nconst x = <button>Hi</button>;`,
      );
      expect(out).not.toContain(SOURCE_ATTR);
    });

    it('stamps normally in a sibling file without the ignore comment', () => {
      const out = transform('const x = <button>Hi</button>;', 'src/Other.tsx');
      expect(out).toContain(SOURCE_ATTR);
    });

    it('does not stamp components in an ignored file (consistent behavior)', () => {
      const out = transform(`// @reticle-ignore\nconst x = <App />;`);
      expect(out).not.toContain(SOURCE_ATTR);
    });

    it('preserves the ignore comment in output', () => {
      const out = transform(`// @reticle-ignore\nconst x = <button>Hi</button>;`);
      expect(out).toContain('@reticle-ignore');
    });

    it('matches case-insensitively (a marker people type by hand gets typed how they like)', () => {
      const out = transform(`// @Reticle-Ignore\nconst x = <button>Hi</button>;`);
      expect(out).not.toContain(SOURCE_ATTR);
    });

    it('does NOT fire on `@reticle-ignored` (boundary lookahead)', () => {
      const out = transform(`// see docs on @reticle-ignored-paths\nconst x = <button>Hi</button>;`);
      expect(out).toContain(SOURCE_ATTR);
    });

    it('fires on block comment /* @reticle-ignore */', () => {
      const out = transform(`/* @reticle-ignore */\nconst x = <button>Hi</button>;`);
      expect(out).not.toContain(SOURCE_ATTR);
    });

    it('fires when marker appears mid-file (token match, not first-line-only)', () => {
      const out = transform(`const x = <button>Hi</button>;\n// @reticle-ignore`);
      expect(out).not.toContain(SOURCE_ATTR);
    });
  });
});

/**
 * A lowercase JSX tag is not the same thing as a DOM element.
 *
 * Filed from the field, against a CAD app: `sourceMapping` is on by default, and it stamped
 * `data-reticle-source` onto `<mesh>`, `<group>` and every other react-three-fiber intrinsic.
 * R3F is a separate reconciler whose "host elements" are three.js objects, and `applyProps` reads
 * ANY prop containing a dash as a pierced property path — so `data-reticle-source` is walked as
 * `data` -> `reticle` -> `source`, finds no `data` object on the instance, and throws:
 *
 *   Uncaught Error: R3F: Cannot set "data-reticle-source". Ensure it is an object before setting
 *       at applyProps (react-three-fiber.esm:434:79)
 *       at commitUpdate (react-three-fiber.esm:8631:5)
 *
 * The throw is unhandled inside the commit phase, so it does not degrade the 3D viewport — it
 * unmounts the whole React app to a white screen with no error UI. And it fires on an UPDATE, not a
 * mount: the reporter's app ran ~20 minutes and passed ~15 verdicts before a new mesh triggered it,
 * which made an instrumentation bug read as an application bug.
 *
 * The rule was "lowercase means host element". The rule is "lowercase AND a real HTML or SVG tag",
 * because only those are guaranteed to accept an arbitrary `data-*` attribute.
 */
describe('non-DOM reconcilers', () => {
  const r3f = ['mesh', 'group', 'points', 'primitive', 'bufferGeometry', 'meshStandardMaterial'];

  it.each(r3f)('does not stamp <%s>, which is a three.js object and not a DOM node', (tag) => {
    expect(transform(`const x = <${tag} />;`)).not.toContain(SOURCE_ATTR);
  });

  it('leaves an unknown bare lowercase tag alone rather than guessing it is DOM', () => {
    // A custom reconciler's intrinsics are unbounded; an allowlist is the only side that can be
    // enumerated. Missing a stamp costs one source pointer, stamping wrongly costs the whole app.
    expect(transform('const x = <box />;')).not.toContain(SOURCE_ATTR);
  });

  it('still stamps a custom element, which IS a DOM node and takes data-* like any other', () => {
    // A dash is the HTML spec's own marker for a custom element, and no reconciler's intrinsics
    // carry one — three.js names are bare identifiers. So the dash is a safe positive signal.
    expect(transform('const x = <sl-button />;')).toContain(SOURCE_ATTR);
  });

  it('still stamps the HTML elements the source mapping exists for', () => {
    for (const tag of ['div', 'button', 'input', 'a', 'form', 'li', 'td']) {
      expect(transform(`const x = <${tag} />;`)).toContain(SOURCE_ATTR);
    }
  });

  it('stamps SVG, which is DOM and takes data-* like any other element', () => {
    for (const tag of ['svg', 'path', 'circle', 'g']) {
      expect(transform(`const x = <${tag} />;`)).toContain(SOURCE_ATTR);
    }
  });

  it('does not stamp a namespaced tag — <svg:rect> is a JSXNamespacedName, not an identifier', () => {
    expect(transform('const x = <svg:rect />;')).not.toContain(SOURCE_ATTR);
  });
});
