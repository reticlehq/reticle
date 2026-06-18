import { describe, expect, it } from 'vitest';
import {
  detect,
  parseMajor,
  installCommand,
  Framework,
  PackageManager,
  type DetectInput,
} from './detect.js';

function input(partial: Partial<DetectInput>): DetectInput {
  return {
    pkg: partial.pkg ?? {},
    configFiles: partial.configFiles ?? new Set(),
    lockfiles: partial.lockfiles ?? new Set(),
  };
}

describe('parseMajor', () => {
  it('reads the major from common range forms', () => {
    expect(parseMajor('^19.0.0')).toBe(19);
    expect(parseMajor('~18.2.1')).toBe(18);
    expect(parseMajor('19.1.1')).toBe(19);
    expect(parseMajor('>=18')).toBe(18);
  });
  it('returns undefined for missing/garbage', () => {
    expect(parseMajor(undefined)).toBeUndefined();
    expect(parseMajor('latest')).toBeUndefined();
  });
});

describe('detect framework', () => {
  it('detects next from the dependency', () => {
    expect(detect(input({ pkg: { dependencies: { next: '15.0.0' } } })).framework).toBe(
      Framework.NEXT,
    );
  });
  it('detects next from a config file even without the dep listed', () => {
    expect(detect(input({ configFiles: new Set(['next.config.mjs']) })).framework).toBe(
      Framework.NEXT,
    );
  });
  it('detects vite from the dependency', () => {
    expect(detect(input({ pkg: { devDependencies: { vite: '^5.0.0' } } })).framework).toBe(
      Framework.VITE,
    );
  });
  it('falls back to html when no bundler is present', () => {
    expect(detect(input({ pkg: { dependencies: { react: '^18' } } })).framework).toBe(
      Framework.HTML,
    );
  });
  it('prefers next over vite when both are present', () => {
    expect(detect(input({ pkg: { dependencies: { next: '15', vite: '5' } } })).framework).toBe(
      Framework.NEXT,
    );
  });
});

describe('detect source mapping need', () => {
  it('flags React 19 as needing source mapping', () => {
    const d = detect(input({ pkg: { dependencies: { react: '^19.0.0', vite: '5' } } }));
    expect(d.reactMajor).toBe(19);
    expect(d.needsSourceMapping).toBe(true);
  });
  it('does not flag React 18', () => {
    const d = detect(input({ pkg: { dependencies: { react: '^18.2.0', vite: '5' } } }));
    expect(d.needsSourceMapping).toBe(false);
  });
});

describe('detect package manager', () => {
  it('reads the lockfile', () => {
    expect(detect(input({ lockfiles: new Set(['pnpm-lock.yaml']) })).packageManager).toBe(
      PackageManager.PNPM,
    );
    expect(detect(input({ lockfiles: new Set(['yarn.lock']) })).packageManager).toBe(
      PackageManager.YARN,
    );
    expect(detect(input({ lockfiles: new Set(['bun.lockb']) })).packageManager).toBe(
      PackageManager.BUN,
    );
    expect(detect(input({})).packageManager).toBe(PackageManager.NPM);
  });
});

describe('installCommand', () => {
  it('renders the dev-install command per manager', () => {
    expect(installCommand(PackageManager.PNPM, '@syrin/iris')).toBe('pnpm add -D @syrin/iris');
    expect(installCommand(PackageManager.NPM, '@syrin/iris')).toBe('npm i -D @syrin/iris');
  });
});
