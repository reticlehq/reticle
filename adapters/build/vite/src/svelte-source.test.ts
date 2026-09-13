import { describe, expect, it, vi } from 'vitest';
import { compile } from 'svelte/compiler';
import { SVELTE_FILE, offsetToLineColumn, stampSvelte } from './svelte-source.js';

// Mirrors DATA_RETICLE_SOURCE_ATTR in core, kept dependency-free here like the sibling suite.
const SOURCE_ATTR = 'data-reticle-source';

/** Every `data-reticle-source` value in a stamped component, in source order. */
function stampedValues(code: string): string[] {
  return [...code.matchAll(/data-reticle-source="([^"]*)"/g)].map((m) => m[1] ?? '');
}

describe('offsetToLineColumn', () => {
  // Matches Babel's convention, which the JSX stamper already emits and `parseSourceAttr` parses:
  // 1-based line, 0-based column. Getting this wrong produces a pointer that looks right and lands
  // one line off, which is worse than no pointer at all.
  const source = 'a\nbb\n\nccc';

  it('is 1-based on line and 0-based on column', () => {
    expect(offsetToLineColumn(source, 0)).toEqual({ line: 1, column: 0 });
    expect(offsetToLineColumn(source, 2)).toEqual({ line: 2, column: 0 });
    expect(offsetToLineColumn(source, 3)).toEqual({ line: 2, column: 1 });
  });

  it('counts an empty line', () => {
    expect(offsetToLineColumn(source, 6)).toEqual({ line: 4, column: 0 });
  });

  it('handles CRLF, so a Windows checkout does not report every line twice', () => {
    expect(offsetToLineColumn('a\r\nb', 3)).toEqual({ line: 2, column: 0 });
  });
});

describe('stampSvelte', () => {
  it('stamps a host element with file:line:column', () => {
    const out = stampSvelte('<div>hi</div>', 'src/App.svelte');
    expect(out).not.toBeNull();
    expect(stampedValues(out ?? '')).toEqual(['src/App.svelte:1:0']);
  });

  it('points at the right line for an element further down the file', () => {
    const source = '<script>\n  let n = 1;\n</script>\n\n<div>\n  <button>Go</button>\n</div>\n';
    const values = stampedValues(stampSvelte(source, 'src/App.svelte') ?? '');
    expect(values).toEqual(['src/App.svelte:5:0', 'src/App.svelte:6:2']);
  });

  it('always uses forward slashes, so a pointer is the same string on every OS', () => {
    const out = stampSvelte('<div>hi</div>', 'src\\routes\\+page.svelte');
    expect(stampedValues(out ?? '')).toEqual(['src/routes/+page.svelte:1:0']);
  });

  it('stamps host elements only — a component is not a place in the DOM', () => {
    const out = stampSvelte('<Widget />\n<svelte:window />\n<p>x</p>', 'src/App.svelte');
    expect(stampedValues(out ?? '')).toEqual(['src/App.svelte:3:0']);
    expect(out).toContain('<Widget />');
  });

  it('reaches elements inside every block form, not just the top level', () => {
    const source =
      '{#if n}\n<p>a</p>\n{:else}\n<p>b</p>\n{/if}\n{#each xs as x}\n<li>{x}</li>\n{/each}';
    expect(stampedValues(stampSvelte(source, 'src/A.svelte') ?? '')).toEqual([
      'src/A.svelte:2:0',
      'src/A.svelte:4:0',
      'src/A.svelte:7:0',
    ]);
  });

  it('is idempotent — a second pass does not double-stamp', () => {
    const once = stampSvelte('<div>hi</div>', 'src/App.svelte') ?? '';
    const twice = stampSvelte(once, 'src/App.svelte') ?? once;
    expect(stampedValues(twice)).toEqual(['src/App.svelte:1:0']);
  });

  it("keeps the element's own attributes and directives intact", () => {
    const source = '<button class="a" on:click={go} {...rest}>Go</button>';
    const out = stampSvelte(source, 'src/App.svelte') ?? '';
    expect(out).toContain('class="a"');
    expect(out).toContain('on:click={go}');
    expect(out).toContain('{...rest}');
  });

  it('returns null rather than throwing on a component the compiler cannot parse', () => {
    // A half-typed file hits the transform on every keystroke in dev. Failing the build over one
    // would make Reticle the reason the dev server is red, for a feature that is pure enrichment.
    expect(stampSvelte('<div>{#if}', 'src/Broken.svelte')).toBeNull();
  });

  it('returns null when svelte is not installed, instead of failing the build', () => {
    expect(stampSvelte('<div>hi</div>', 'src/App.svelte', () => null)).toBeNull();
  });

  it('SVELTE_FILE matches .svelte and nothing else', () => {
    expect(SVELTE_FILE.test('/a/App.svelte')).toBe(true);
    expect(SVELTE_FILE.test('/a/App.svelte.ts')).toBe(false);
    expect(SVELTE_FILE.test('/a/App.tsx')).toBe(false);
  });
});

describe('the stamp survives the Svelte compiler', () => {
  // The property that actually matters. Stamping source the compiler then discards would produce a
  // green unit test and no attribute in the DOM — precisely the false green this project exists to
  // catch, and the reason this asserts on COMPILED output rather than on our own string surgery.
  it('carries data-reticle-source into the generated client component', () => {
    const source = '<div class="card">\n  <button>Pay</button>\n</div>';
    const stamped = stampSvelte(source, 'src/Checkout.svelte') ?? '';
    const generated = compile(stamped, { filename: 'src/Checkout.svelte' }).js.code;
    expect(generated).toContain(SOURCE_ATTR);
    expect(generated).toContain('src/Checkout.svelte:1:0');
    expect(generated).toContain('src/Checkout.svelte:2:2');
  });

  it('renders the attribute into real HTML on the server compiler', () => {
    const stamped = stampSvelte('<p>hello</p>', 'src/P.svelte') ?? '';
    const generated = compile(stamped, {
      filename: 'src/P.svelte',
      generate: 'server',
    }).js.code;
    expect(generated).toContain('src/P.svelte:1:0');
  });

  it('compiles to the same component apart from the attribute', () => {
    const source = '<script>let n = 1;</script>\n<button onclick={() => n++}>{n}</button>';
    const plain = compile(source, { filename: 'src/C.svelte' }).js.code;
    const stamped = compile(stampSvelte(source, 'src/C.svelte') ?? '', {
      filename: 'src/C.svelte',
    }).js.code;
    expect(stamped.replace(/ ?data-reticle-source="[^"]*"/g, '').replace(/\s+/g, ' ')).toBe(
      plain.replace(/\s+/g, ' '),
    );
  });
});

describe('the compiler is reached only for a .svelte file', () => {
  it('asks for the compiler exactly once per component and not at all otherwise', () => {
    // The regression that would matter most is a React-only build paying for — or breaking on — a
    // Svelte compiler it has no reason to have. `stampSvelte` is the only thing that ever calls the
    // loader, and it is only reachable through a `.svelte` id.
    const loader = vi.fn(() => null);
    expect(SVELTE_FILE.test('/app/src/main.tsx')).toBe(false);
    expect(loader).not.toHaveBeenCalled();

    stampSvelte('<div>a</div>', 'a.svelte', loader);
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
