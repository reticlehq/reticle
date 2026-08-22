import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_RETICLE_SOURCE_ATTR, SOURCE_CONTRACT } from './source-constants.js';
import { renderSourceContract } from '../scripts/gen-source-contract.mjs';

/**
 * The source-mapping attribute has to hold across module systems that cannot import each other: the
 * ESM browser SDK and React adapter read it, and @reticlehq/babel-plugin — plain CommonJS, because
 * Babel loads a plugin with require() — writes it.
 *
 * It used to hold because both sides declared the literal and carried a comment pointing at the
 * other. Drift there breaks all source mapping on the React 19 / Next SWC path, and nothing sees it:
 * the reader looks for one attribute, the writer stamps another, and every test still passes.
 *
 * The CommonJS view is now GENERATED from the TypeScript source, so drift is impossible rather than
 * policed. What is still worth asserting is that the generator stays honest and that the committed
 * build output is current.
 */
describe('source contract generation', () => {
  it('renders every exported constant into the CommonJS view', () => {
    const rendered = renderSourceContract(SOURCE_CONTRACT);
    for (const [name, value] of Object.entries(SOURCE_CONTRACT)) {
      expect(rendered, `${name} must reach the CJS side`).toContain(name);
      expect(rendered, `${name}'s value must reach the CJS side`).toContain(JSON.stringify(value));
    }
  });

  it('carries the attribute the SDK actually reads', () => {
    // Guards the guard: an empty SOURCE_CONTRACT would satisfy the loop above for free.
    expect(Object.keys(SOURCE_CONTRACT).length).toBeGreaterThan(0);
    expect(SOURCE_CONTRACT.DATA_RETICLE_SOURCE_ATTR).toBe(DATA_RETICLE_SOURCE_ATTR);
  });

  it('renders a module CommonJS tooling can actually require', () => {
    const rendered = renderSourceContract({ EXAMPLE: 'value' });
    expect(rendered).toContain("'use strict'");
    expect(rendered).toContain('exports.EXAMPLE');
    // Frozen so a plugin cannot mutate the contract out from under the SDK.
    expect(rendered).toContain('Object.freeze(exports)');
  });

  it('marks the output as generated so nobody hand-edits it', () => {
    expect(renderSourceContract(SOURCE_CONTRACT)).toMatch(/GENERATED/);
  });

  /**
   * The two failures the generator cannot prevent: a constant changed in source and the package
   * published without rebuilding, and the generator not running at all.
   */
  it('the committed build output matches the source', () => {
    const built = join(__dirname, '..', 'dist', 'source-contract.cjs');
    if (!existsSync(built)) {
      // A source-only checkout has no dist; the assertions above already cover the renderer.
      return;
    }
    expect(readFileSync(built, 'utf8')).toBe(renderSourceContract(SOURCE_CONTRACT));
  });
});
