/**
 * Pure framework + toolchain detection for `reticle init`. No filesystem access — callers pass in
 * the parsed package.json and the set of config/lock filenames present in the project root.
 */

export const Framework = {
  NEXT: 'next',
  VITE: 'vite',
  SVELTEKIT: 'sveltekit',
  HTML: 'html',
} as const;
export type Framework = (typeof Framework)[keyof typeof Framework];

export const PackageManager = {
  PNPM: 'pnpm',
  YARN: 'yarn',
  BUN: 'bun',
  NPM: 'npm',
} as const;
export type PackageManager = (typeof PackageManager)[keyof typeof PackageManager];

interface PackageJsonLike {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export interface DetectInput {
  pkg: PackageJsonLike;
  /** Basenames of config files present in the project root (e.g. 'next.config.mjs'). */
  configFiles: ReadonlySet<string>;
  /** Lockfile basenames present in the project root. */
  lockfiles: ReadonlySet<string>;
}

export interface Detection {
  framework: Framework;
  reactMajor: number | undefined;
  /** React 19 dropped _debugSource, so it needs the build-time source-map stamp. */
  needsSourceMapping: boolean;
  packageManager: PackageManager;
}

const NEXT_CONFIGS = ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.cjs'];
const VITE_CONFIGS = ['vite.config.js', 'vite.config.ts', 'vite.config.mjs', 'vite.config.mts'];
const SVELTE_CONFIGS = ['svelte.config.js', 'svelte.config.ts', 'svelte.config.mjs'];

function depVersion(pkg: PackageJsonLike, name: string): string | undefined {
  return pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? pkg.peerDependencies?.[name];
}

function hasAnyConfig(files: ReadonlySet<string>, candidates: readonly string[]): boolean {
  return candidates.some((c) => files.has(c));
}

/** Extract the leading major version from a semver range like "^19.0.0" or "19.1.1". */
export function parseMajor(range: string | undefined): number | undefined {
  if (range === undefined) return undefined;
  const match = range.match(/(\d+)/);
  if (match === null || match[1] === undefined) return undefined;
  const major = parseInt(match[1], 10);
  return isNaN(major) ? undefined : major;
}

function detectPackageManager(lockfiles: ReadonlySet<string>): PackageManager {
  if (lockfiles.has('pnpm-lock.yaml')) return PackageManager.PNPM;
  if (lockfiles.has('yarn.lock')) return PackageManager.YARN;
  if (lockfiles.has('bun.lockb') || lockfiles.has('bun.lock')) return PackageManager.BUN;
  return PackageManager.NPM;
}

function detectFramework(input: DetectInput): Framework {
  const { pkg, configFiles } = input;
  if (depVersion(pkg, 'next') !== undefined || hasAnyConfig(configFiles, NEXT_CONFIGS)) {
    return Framework.NEXT;
  }
  // SvelteKit is Vite-based but renders through app.html, so the Vite plugin's index.html injection
  // never fires (verified) — it needs a manual client connect. Check BEFORE the generic Vite branch.
  if (depVersion(pkg, '@sveltejs/kit') !== undefined || hasAnyConfig(configFiles, SVELTE_CONFIGS)) {
    return Framework.SVELTEKIT;
  }
  if (depVersion(pkg, 'vite') !== undefined || hasAnyConfig(configFiles, VITE_CONFIGS)) {
    return Framework.VITE;
  }
  return Framework.HTML;
}

export function detect(input: DetectInput): Detection {
  const reactMajor = parseMajor(depVersion(input.pkg, 'react'));
  return {
    framework: detectFramework(input),
    reactMajor,
    needsSourceMapping: reactMajor !== undefined && reactMajor >= 19,
    packageManager: detectPackageManager(input.lockfiles),
  };
}

const INSTALL_ARGS: Record<PackageManager, readonly string[]> = {
  [PackageManager.PNPM]: ['add', '-D'],
  [PackageManager.YARN]: ['add', '-D'],
  [PackageManager.BUN]: ['add', '-d'],
  [PackageManager.NPM]: ['i', '-D'],
};

interface InstallCommand {
  command: string;
  args: string[];
}

/** Build a dev-dependency install command for one or more packages (e.g. the kit + its build plugin). */
export function installCommandParts(
  pm: PackageManager,
  pkgs: string | readonly string[],
): InstallCommand {
  const list = typeof pkgs === 'string' ? [pkgs] : pkgs;
  return { command: pm, args: [...INSTALL_ARGS[pm], ...list] };
}

export function installCommand(pm: PackageManager, pkgs: string | readonly string[]): string {
  const { command, args } = installCommandParts(pm, pkgs);
  return `${command} ${args.join(' ')}`;
}
