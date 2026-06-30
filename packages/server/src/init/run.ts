/**
 * The impure shell for `reticle init`: gather project files via an injected IO surface, build the
 * plan (pure), optionally write the apply-steps, and print a human-readable report. All filesystem
 * access goes through `InitIo` so the orchestration is unit-testable with an in-memory IO.
 */

import { dirname, join } from 'node:path';
import { detect, Framework, type DetectInput } from './detect.js';
import { buildPlan, StepStatus, type Plan, type PlanInput } from './plan.js';
import { claudeAvailableProbe, claudeExistsProbe } from './mcp.js';
import { CURSOR_DIR_RELPATH, CURSOR_MCP_RELPATH } from './cursor.js';
import { deriveProjectId, packageName } from './project-id.js';

/** Lockfile basenames, in package-manager preference order (mirrors detect.ts). */
const LOCKFILE_NAMES = [
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'package-lock.json',
] as const;

/**
 * Resolve the lockfiles set used to pick the package manager. A lockfile in the project root wins;
 * otherwise we walk UP the directory tree (monorepos keep the lockfile at the workspace root, not in
 * each package) so `reticle init` in a sub-package suggests `pnpm add` instead of defaulting to `npm i`.
 */
export function resolveLockfiles(
  rootFiles: ReadonlySet<string>,
  cwd: string,
  io: Pick<InitIo, 'exists'>,
): Set<string> {
  const set = new Set(rootFiles);
  if (LOCKFILE_NAMES.some((name) => set.has(name))) return set; // local lockfile is authoritative
  let dir = cwd;
  for (let depth = 0; depth < 50; depth++) {
    for (const name of LOCKFILE_NAMES) {
      if (io.exists(join(dir, name))) {
        set.add(name);
        return set;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return set;
}

const PACKAGE_JSON = 'package.json';
const NEXT_RETICLE_DEV = 'app/reticle-dev.tsx';
const SVELTEKIT_HOOKS = 'src/hooks.client.ts';
const VITE_CONFIG_CANDIDATES = [
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.mts',
];
const NEXT_CONFIG_CANDIDATES = [
  'next.config.mjs',
  'next.config.js',
  'next.config.ts',
  'next.config.cjs',
];

export interface InitOptions {
  cwd: string;
  port: number | undefined;
  mcp: boolean;
  dryRun: boolean;
  install: boolean;
}

export interface InitIo {
  /** Returns file content or null if it does not exist. Path is project-relative or absolute. */
  readFile(relPath: string): string | null;
  /** Writes content, creating parent directories. Path is project-relative or absolute. */
  writeFile(relPath: string, content: string): void;
  exists(relPath: string): boolean;
  /** The user's home directory (for global agent config like ~/.cursor/mcp.json). */
  homeDir(): string;
  /** Basenames present in the project root. */
  rootFiles(): readonly string[];
  /** Runs a subprocess to completion (inherits stdio); returns true on exit code 0. */
  exec(command: string, args: readonly string[]): boolean;
  /** Runs a subprocess quietly (no stdio) for a yes/no check; returns true on exit code 0. */
  probe(command: string, args: readonly string[]): boolean;
  print(line: string): void;
}

interface InitResult {
  ok: boolean;
  applied: number;
  manual: number;
}

const STATUS_SYMBOL: Record<StepStatus, string> = {
  [StepStatus.APPLY]: '✓',
  [StepStatus.MANUAL]: '⚠',
  [StepStatus.ALREADY]: '·',
  [StepStatus.SKIP]: '–',
};

function firstPresent(files: ReadonlySet<string>, candidates: readonly string[]): string | null {
  for (const c of candidates) if (files.has(c)) return c;
  return null;
}

function gatherPlanInput(options: InitOptions, io: InitIo, pkgRaw: string): PlanInput {
  const pkg: unknown = JSON.parse(pkgRaw);
  // Stable identity derived from the app's package.json name + root, so it survives port changes.
  const projectId = deriveProjectId(packageName(pkg), options.cwd);
  const rootFiles = new Set(io.rootFiles());
  const detectInput: DetectInput = {
    pkg: typeof pkg === 'object' && pkg !== null ? pkg : {},
    configFiles: rootFiles,
    // Walk up for the lockfile so a monorepo sub-package picks the workspace's package manager.
    lockfiles: resolveLockfiles(rootFiles, options.cwd, io),
  };
  const detection = detect(detectInput);

  const vitePath = firstPresent(rootFiles, VITE_CONFIG_CANDIDATES);
  const viteSource = vitePath === null ? null : io.readFile(vitePath);
  const viteConfig =
    vitePath !== null && viteSource !== null ? { path: vitePath, source: viteSource } : null;

  // Global MCP registration targets each agent that's present: Claude via its CLI, Cursor via its
  // global config file. Only probe when the MCP step is in play.
  const availableProbe = claudeAvailableProbe();
  const claudeCli = options.mcp ? io.probe(availableProbe.command, availableProbe.args) : false;
  const existsProbe = claudeExistsProbe();
  const mcpExists = claudeCli ? io.probe(existsProbe.command, existsProbe.args) : false;

  const cursorDir = `${io.homeDir()}/${CURSOR_DIR_RELPATH}`;
  const cursorConfigPath = `${io.homeDir()}/${CURSOR_MCP_RELPATH}`;
  const cursorPresent = options.mcp && io.exists(cursorDir);
  const cursorConfig = cursorPresent ? io.readFile(cursorConfigPath) : null;

  return {
    detection,
    claudeCli,
    mcpExists,
    cursorPresent,
    cursorConfig,
    cursorConfigPath,
    viteConfig,
    nextConfigFile: firstPresent(rootFiles, NEXT_CONFIG_CANDIDATES),
    nextReticleDevExists: io.exists(NEXT_RETICLE_DEV),
    svelteKitHooksExists: io.exists(SVELTEKIT_HOOKS),
    reticleConfigExists: io.exists('.reticle.json'),
    options: { port: options.port, mcp: options.mcp, install: options.install, projectId },
  };
}

function restartHint(framework: Framework): string {
  if (framework === Framework.NEXT)
    return 'Restart `next dev`, then ask your agent: "List Reticle Reticle sessions".';
  if (framework === Framework.VITE)
    return 'Restart `vite`, then ask your agent: "List Reticle Reticle sessions".';
  if (framework === Framework.SVELTEKIT)
    return 'Restart your dev server (`npm run dev`), then ask your agent: "List Reticle Reticle sessions".';
  return 'Reload your app on localhost, then ask your agent: "List Reticle Reticle sessions".';
}

function report(plan: Plan, dryRun: boolean, failed: ReadonlySet<string>, io: InitIo): InitResult {
  io.print(dryRun ? 'reticle init (dry run — no files written)' : 'reticle init');
  io.print('');
  let applied = 0;
  let manual = 0;
  for (const s of plan.steps) {
    // A side effect that failed to apply is reported as a manual step with its fallback command.
    const downgraded = failed.has(s.target);
    const status = downgraded ? StepStatus.MANUAL : s.status;
    const detail =
      downgraded && s.exec !== undefined
        ? `step failed — run manually: ${s.exec.fallback}`
        : s.detail;
    io.print(`  [${STATUS_SYMBOL[status]}] ${s.title} → ${s.target}`);
    if (status === StepStatus.APPLY) applied++;
    if (status === StepStatus.MANUAL) {
      manual++;
      for (const line of detail.split('\n')) io.print(`      ${line}`);
    } else if (detail.length > 0) {
      io.print(`      ${detail}`);
    }
  }
  io.print('');
  io.print(restartHint(plan.framework));
  return { ok: true, applied, manual };
}

/** Perform the apply-step side effects; return the targets whose side effect failed. */
function applyEffects(plan: Plan, io: InitIo): Set<string> {
  const failed = new Set<string>();
  for (const s of plan.steps) {
    if (s.status !== StepStatus.APPLY) continue;
    if (s.write !== undefined) io.writeFile(s.write.path, s.write.content);
    if (s.exec !== undefined && !io.exec(s.exec.command, s.exec.args)) failed.add(s.target);
  }
  return failed;
}

export function runInit(options: InitOptions, io: InitIo): InitResult {
  const pkgRaw = io.readFile(PACKAGE_JSON);
  if (pkgRaw === null) {
    io.print('No package.json found. Run `reticle init` from your project root.');
    return { ok: false, applied: 0, manual: 0 };
  }

  const plan = buildPlan(gatherPlanInput(options, io, pkgRaw));
  const failed = options.dryRun ? new Set<string>() : applyEffects(plan, io);
  return report(plan, options.dryRun, failed, io);
}
