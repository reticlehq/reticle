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
});

/**
 * A lowercase JSX tag is not the same thing as a DOM element.
 *
 * `sourceMapping` is on by default, so it stamps `data-reticle-source` onto `<mesh>`, `<group>` and
 * every other react-three-fiber intrinsic. R3F is a separate reconciler whose "host elements" are
 * three.js objects, and `applyProps` reads ANY prop containing a dash as a pierced property path — so `data-reticle-source` is walked as
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

/**
 * Source mapping is JSX-syntactic, and therefore already works on Preact (#129).
 *
 * #129 lists source mapping as one of four things Preact is missing: "Preact under
 * `@preact/preset-vite` needs its own stamping path". It does not. Nothing in this plugin reads
 * React: it stamps a JSX host element by tag name, and Preact's host elements are the same HTML
 * tags. `docs/frameworks.mdx` separately records Preact's source pointer as "unproven", which is
 * the honest thing to say about something nothing tested -- so these tests are what changes the
 * answer from unproven to measured.
 *
 * Pinned as its own block because the properties below are exactly the ones a React-shaped
 * assumption would break: Preact takes `class` rather than `className`, uses its own JSX import
 * source, and its idiomatic state layer puts a signal object straight into the tree.
 */
describe('Preact', () => {
  const PREACT_COMPONENT = `/** @jsxImportSource preact */
import { signal } from '@preact/signals';
const count = signal(0);
export function Counter() {
  return (
    <div class="counter">
      <button data-testid="inc" onClick={() => count.value++}>Increment</button>
      <span>{count}</span>
    </div>
  );
}`;

  it('stamps a Preact component, with no React anywhere in the file', () => {
    const out = transform(PREACT_COMPONENT, 'src/Counter.jsx');
    // Every host element in the tree, not just the first: a verdict lands on the control that was
    // clicked, and the button is the one an agent acts on.
    expect(out).toContain(`<div class="counter" ${SOURCE_ATTR}="src/Counter.jsx:6:4"`);
    expect(out).toContain(`${SOURCE_ATTR}="src/Counter.jsx:7:6"`);
    expect(out).toContain(`${SOURCE_ATTR}="src/Counter.jsx:8:6"`);
  });

  it('is not confused by `class` where React would write `className`', () => {
    // The attribute Preact accepts and React does not. A stamper keyed on React's DOM property
    // names rather than on the tag would have to special-case this; this one never looks.
    const out = transform('const x = <div class="card" />;', 'src/Card.jsx');
    expect(out).toContain(SOURCE_ATTR);
    expect(out).toContain('class="card"');
  });

  it('leaves a `@jsxImportSource preact` pragma intact', () => {
    // The pragma is what routes JSX to Preact's runtime. Rewriting or dropping it would change
    // which framework renders the file, which is a far larger thing to get wrong than a missing
    // source pointer.
    const out = transform(PREACT_COMPONENT, 'src/Counter.jsx');
    expect(out).toContain('@jsxImportSource preact');
  });

  it('stamps a `.tsx` Preact component too', () => {
    const out = transform(
      'export const Badge = ({ label }: { label: string }) => <span class="badge">{label}</span>;',
      'src/Badge.tsx',
    );
    expect(out).toContain('src/Badge.tsx:1:');
  });

  it('still does not stamp a Preact component element, only host elements', () => {
    // Same rule as React: `<Counter />` is not a DOM node and cannot take a data- attribute.
    expect(transform('const x = <Counter />;', 'src/App.jsx')).not.toContain(SOURCE_ATTR);
  });
});
