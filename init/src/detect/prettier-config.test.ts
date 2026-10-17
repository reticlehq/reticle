/**
 * Detecting whether a project uses Prettier — config file, package.json "prettier" key,
 * or prettier in (dev)dependencies.
 */

import { describe, expect, it } from 'vitest';
import { hasPrettierConfig } from './prettier-config.js';

describe('detecting Prettier usage', () => {
  it('finds a .prettierrc config file', () => {
    expect(hasPrettierConfig(new Set(['.prettierrc', 'package.json']), {})).toBe(true);
  });

  it('finds a prettier.config.js file', () => {
    expect(hasPrettierConfig(new Set(['prettier.config.js']), {})).toBe(true);
  });

  it('finds the "prettier" key in package.json', () => {
    expect(hasPrettierConfig(new Set(['package.json']), { prettier: { semi: false } })).toBe(true);
  });

  it('finds prettier in devDependencies', () => {
    expect(
      hasPrettierConfig(new Set(['package.json']), { devDependencies: { prettier: '^3.0.0' } }),
    ).toBe(true);
  });

  it('finds prettier in dependencies', () => {
    expect(
      hasPrettierConfig(new Set(['package.json']), { dependencies: { prettier: '^3.0.0' } }),
    ).toBe(true);
  });

  it('is false when nothing indicates Prettier', () => {
    expect(hasPrettierConfig(new Set(['package.json', 'tsconfig.json']), {})).toBe(false);
    expect(hasPrettierConfig(new Set(['package.json']), { scripts: {} } as never)).toBe(false);
  });
});
