import { describe, expect, it } from 'vitest';
import {
  MAX_SCRIPTS,
  buildDictionary,
  chunkImports,
  comparedLiterals,
  harvestDictionary,
  magicValues,
  scriptSources,
} from './value-dictionary.js';

describe('value dictionary', () => {
  it('finds the scripts a page loads and the chunks a script imports', () => {
    expect(
      scriptSources(
        '<script type="module" src="/assets/index-a1.js"></script><script>x()</script>',
      ),
    ).toEqual(['/assets/index-a1.js']);
    expect(chunkImports('import{a}from"./chunk-b2.js";import("../lazy/c3.js")')).toEqual([
      './chunk-b2.js',
      '../lazy/c3.js',
    ]);
  });

  it('follows the modules a dev server serves, and leaves out library code', () => {
    expect(
      chunkImports(
        'import App from "/src/App.tsx";import "./form.ts?t=1";import r from "/node_modules/.vite/deps/react.js?v=1";import "/@vite/client"',
      ),
    ).toEqual(['/src/App.tsx', './form.ts?t=1']);
  });

  it('collects the literals a named value is compared with, on either side', () => {
    expect(
      comparedLiterals(
        'if(values.route==="progress"){} if (form.mode !== \'draft\') {} if ("vip"==user.tier) {}',
      ),
    ).toEqual([
      ['route', 'progress'],
      ['mode', 'draft'],
      ['tier', 'vip'],
    ]);
  });

  it('collects switch cases and includes() lists for the named value, from minified code', () => {
    const js =
      'function r(e){switch(e.kind){case"draft":return 1;case"live":return 2;default:return 0}}' +
      'const v=t=>["pro","team"].includes(t.plan);';
    expect(comparedLiterals(js)).toEqual([
      ['kind', 'draft'],
      ['kind', 'live'],
      ['plan', 'pro'],
      ['plan', 'team'],
    ]);
  });

  it('gives a field the values of its folded name, or of a name of 3+ characters it ends with', () => {
    const dict = buildDictionary([
      ['route', 'progress'],
      ['route', 'done'],
      ['id', 'x'],
    ]);
    expect(magicValues(dict, 'Route')).toEqual(['progress', 'done']);
    expect(magicValues(dict, 'Delivery route')).toEqual(['progress', 'done']);
    expect(magicValues(dict, 'Order id')).toEqual([]);
    expect(magicValues(dict, '')).toEqual([]);
  });

  it('keeps at most 4 values for a name', () => {
    const dict = buildDictionary(
      ['a', 'b', 'c', 'd', 'e'].map((v) => ['mode', v] as [string, string]),
    );
    expect(magicValues(dict, 'mode')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('fetches the page and follows its scripts like a browser, up to a cap', async () => {
    const files: Record<string, string> = {
      'http://app/': '<script src="/main.js"></script>',
      'http://app/main.js': 'import "./step.js"; if(v.route==="progress"){}',
      'http://app/step.js': 'if(v.plan==="pro"){}',
    };
    const fetched: string[] = [];
    const dict = await harvestDictionary('http://app/', (url) => {
      fetched.push(url);
      return Promise.resolve(files[url]);
    });
    expect(magicValues(dict, 'route')).toEqual(['progress']);
    expect(magicValues(dict, 'plan')).toEqual(['pro']);
    expect(fetched).toHaveLength(3);
    expect(MAX_SCRIPTS).toBe(40);
  });
});
