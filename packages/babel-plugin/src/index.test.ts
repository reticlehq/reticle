import { describe, it, expect } from 'vitest';
import { transformSync } from '@babel/core';
import plugin, { SOURCE_ATTR } from './index.js';

function transform(code: string): string {
  const out = transformSync(code, {
    filename: 'src/Foo.tsx',
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

  it('does not stamp components', () => {
    const out = transform('const x = <App />;');
    expect(out).not.toContain(SOURCE_ATTR);
  });

  it('is idempotent (does not double-stamp)', () => {
    const out = transform(`const x = <div ${SOURCE_ATTR}="existing">x</div>;`);
    expect((out.match(/data-reticle-source/g) ?? []).length).toBe(1);
  });
});
