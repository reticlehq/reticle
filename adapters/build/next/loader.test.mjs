import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const loader = require('./loader.cjs');

// Mirrors DATA_RETICLE_SOURCE_ATTR in @reticlehq/core. This package is plain CJS and does not
// depend on core; the babel plugin it calls stamps this name. #456 is the job that makes the
// name come from core rather than a literal.
const SOURCE_ATTR = 'data-reticle-source';

/**
 * Drive the webpack loader the way webpack does: `this.async()` plus `this.resourcePath`.
 * @param {string} source
 * @param {string} resourcePath
 */
function runLoader(source, resourcePath) {
  return new Promise((resolve, reject) => {
    const ctx = {
      resourcePath,
      async() {
        return (err, code, map) => {
          if (err) reject(err);
          else resolve({ code, map });
        };
      },
    };
    loader.call(ctx, source, undefined);
  });
}

describe('reticle next loader', () => {
  it('stamps host elements with data-reticle-source (file:line:col)', async () => {
    const { code } = await runLoader('const x = <button>Hi</button>;', 'src/Foo.tsx');
    expect(code).toContain(SOURCE_ATTR);
    expect(code).toMatch(/src\/Foo\.tsx:1:\d+/);
  });

  it('emits forward slashes on every OS, so a pointer is the same string everywhere', async () => {
    const { code } = await runLoader('const x = <span>Hi</span>;', 'src/deep/Bar.tsx');
    expect(code).toContain('src/deep/Bar.tsx:1:');
    expect(code).not.toContain('\\');
  });

  it('does not stamp components', async () => {
    const { code } = await runLoader('const x = <App />;', 'src/Foo.tsx');
    expect(code).not.toContain(SOURCE_ATTR);
  });

  it('leaves non-JSX files untouched, so SWC still owns the real compile', async () => {
    const source = 'export const n = 1;';
    const { code } = await runLoader(source, 'src/util.ts');
    expect(code).toBe(source);
  });

  it('skips node_modules, even when the file is TSX', async () => {
    const source = 'const x = <button>Hi</button>;';
    const { code } = await runLoader(source, '/app/node_modules/ui/Button.tsx');
    expect(code).toBe(source);
    expect(code).not.toContain(SOURCE_ATTR);
  });
});
