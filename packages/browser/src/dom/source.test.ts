import { describe as suite, it, expect, beforeEach } from 'vitest';
import { describe } from './a11y.js';
import { parseSourceAttr, sourceFromDom, formatSource } from './source.js';

beforeEach(() => {
  document.body.innerHTML = '';
});

suite('source lookup', () => {
  it('parses the stamped file:line:column, dropping the column', () => {
    expect(parseSourceAttr('src/components/Topbar.tsx:31:6')).toEqual({
      file: 'src/components/Topbar.tsx',
      line: 31,
    });
  });

  it('tolerates windows-ish paths that contain colons', () => {
    expect(parseSourceAttr('C:/app/src/Topbar.tsx:31:6')).toEqual({
      file: 'C:/app/src/Topbar.tsx',
      line: 31,
    });
  });

  it('rejects values that are not a stamped location', () => {
    expect(parseSourceAttr(null)).toBeUndefined();
    expect(parseSourceAttr('')).toBeUndefined();
    expect(parseSourceAttr('src/Topbar.tsx')).toBeUndefined();
    expect(parseSourceAttr(':31:6')).toBeUndefined();
  });

  it('finds the stamp on an ancestor, not just the element itself', () => {
    document.body.innerHTML =
      '<div data-reticle-source="src/Topbar.tsx:31:6"><span><button>Go</button></span></div>';
    const btn = document.querySelector('button') as HTMLElement;
    expect(sourceFromDom(btn)).toEqual({ file: 'src/Topbar.tsx', line: 31 });
  });

  it('prefers the nearest stamp when several are nested', () => {
    document.body.innerHTML =
      '<div data-reticle-source="src/App.tsx:1:0">' +
      '<div data-reticle-source="src/Topbar.tsx:31:6"><button>Go</button></div></div>';
    const btn = document.querySelector('button') as HTMLElement;
    expect(sourceFromDom(btn)).toEqual({ file: 'src/Topbar.tsx', line: 31 });
  });

  it('formats as the file:line an agent can open', () => {
    expect(formatSource({ file: 'src/Topbar.tsx', line: 31 })).toBe('src/Topbar.tsx:31');
    expect(formatSource(undefined)).toBeUndefined();
  });
});

/**
 * The descriptor is what the agent actually reads back from reticle_query, reticle_snapshot and the
 * crawl anomalies. Carrying source here is what makes "this control is broken" and "open this file"
 * the same tool call instead of two.
 */
suite('element descriptors carry their source', () => {
  it('reports the source of a described element', () => {
    document.body.innerHTML =
      '<div data-reticle-source="src/components/Topbar.tsx:31:6">' +
      '<button data-testid="new-deploy">New deploy</button></div>';
    const btn = document.querySelector('button') as HTMLElement;
    expect(describe(btn).source).toBe('src/components/Topbar.tsx:31');
  });

  it('omits source entirely when the app was not built with the stamp', () => {
    document.body.innerHTML = '<button>New deploy</button>';
    const btn = document.querySelector('button') as HTMLElement;
    expect(describe(btn).source).toBeUndefined();
  });
});
