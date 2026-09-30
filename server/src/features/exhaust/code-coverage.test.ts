import { describe, expect, it } from 'vitest';
import { appFileOf, emptyCodeCoverage, foldCodeCoverage, summarizeCode } from './code-coverage.js';

/*
 * Every other coverage number measures what Reticle already knew about: routes it saw, controls it
 * listed. None of them can say what NEVER ran. Function coverage from the browser can, because it is
 * counted against the app's own source rather than against what the driving found.
 */
const fn = (functionName: string, startOffset: number, count: number) => ({
  functionName,
  ranges: [{ startOffset, endOffset: startOffset + 10, count }],
});

describe('appFileOf — which scripts are the app', () => {
  it('keeps app source and drops dependencies, dev-server internals and the SDK', () => {
    expect(appFileOf('http://localhost:5173/src/App.tsx?t=123')).toBe('src/App.tsx');
    expect(appFileOf('http://localhost:5173/node_modules/.vite/deps/react.js')).toBeUndefined();
    expect(appFileOf('http://localhost:5173/@vite/client')).toBeUndefined();
    expect(appFileOf('http://localhost:5173/@react-refresh')).toBeUndefined();
    expect(
      appFileOf('http://localhost:5173/@fs/Users/x/node_modules/@reticlehq/browser/dist/i.js'),
    ).toBeUndefined();
    expect(appFileOf('http://localhost:5173/assets/index-abc.css')).toBeUndefined();
    // Found by driving the fixture: a monorepo serves Reticle's own SDK from its built output.
    expect(
      appFileOf('http://h/@fs/Users/x/adapters/realm/browser/dist/reticle.js'),
    ).toBeUndefined();
  });
});

describe('foldCodeCoverage', () => {
  const take = [
    {
      url: 'http://localhost:5173/src/Cart.tsx',
      functions: [
        fn('', 0, 1),
        fn('addItem', 20, 3),
        fn('removeItem', 60, 0),
        fn('checkout', 90, 0),
      ],
    },
    { url: 'http://localhost:5173/node_modules/.vite/deps/react.js', functions: [fn('x', 5, 1)] },
  ];

  it('counts app functions that ran, and names the ones that never did', () => {
    const summary = summarizeCode(foldCodeCoverage(emptyCodeCoverage(), take));
    expect(summary.total).toBe(3);
    expect(summary.executed).toBe(1);
    expect(summary.files).toEqual([
      { file: 'src/Cart.tsx', functions: 3, executed: 1, unexecuted: ['removeItem', 'checkout'] },
    ]);
  });

  it('is a union across takes: a function that ran once stays run', () => {
    const later = [
      { url: 'http://localhost:5173/src/Cart.tsx', functions: [fn('removeItem', 60, 2)] },
    ];
    const summary = summarizeCode(
      foldCodeCoverage(foldCodeCoverage(emptyCodeCoverage(), take), later),
    );
    expect(summary.executed).toBe(2);
    expect(summary.files[0]?.unexecuted).toEqual(['checkout']);
  });
});
