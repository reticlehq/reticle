/**
 * The impure shell for `iris init`: gather project files via an injected IO surface, build the
 * plan (pure), optionally write the apply-steps, and print a human-readable report. All filesystem
 * access goes through `InitIo` so the orchestration is unit-testable with an in-memory IO.
 */

import { detect, Framework, type DetectInput } from './detect.js';
import { buildPlan, StepStatus, type Plan, type PlanInput } from './plan.js';

const PACKAGE_JSON = 'package.json';
const MCP_FILE = '.mcp.json';
const NEXT_IRIS_DEV = 'app/iris-dev.tsx';
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
  /** Returns file content or null if it does not exist. Path is project-relative. */
  readFile(relPath: string): string | null;
  /** Writes content, creating parent directories. Path is project-relative. */
  writeFile(relPath: string, content: string): void;
  exists(relPath: string): boolean;
  /** Basenames present in the project root. */
  rootFiles(): readonly string[];
  /** Runs a subprocess to completion; returns true on exit code 0. */
  exec(command: string, args: readonly string[]): boolean;
  print(line: string): void;
}

export interface InitResult {
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
  const rootFiles = new Set(io.rootFiles());
  const detectInput: DetectInput = {
    pkg: typeof pkg === 'object' && pkg !== null ? pkg : {},
    configFiles: rootFiles,
    lockfiles: rootFiles,
  };
  const detection = detect(detectInput);

  const vitePath = firstPresent(rootFiles, VITE_CONFIG_CANDIDATES);
  const viteSource = vitePath === null ? null : io.readFile(vitePath);
  const viteConfig =
    vitePath !== null && viteSource !== null ? { path: vitePath, source: viteSource } : null;

  return {
    detection,
    mcpJson: io.readFile(MCP_FILE),
    viteConfig,
    nextConfigFile: firstPresent(rootFiles, NEXT_CONFIG_CANDIDATES),
    nextIrisDevExists: io.exists(NEXT_IRIS_DEV),
    options: { port: options.port, mcp: options.mcp, install: options.install },
  };
}

function restartHint(framework: Framework): string {
  if (framework === Framework.NEXT)
    return 'Restart `next dev`, then ask your agent: "List Iris sessions".';
  if (framework === Framework.VITE)
    return 'Restart `vite`, then ask your agent: "List Iris sessions".';
  return 'Reload your app on localhost, then ask your agent: "List Iris sessions".';
}

function report(plan: Plan, dryRun: boolean, failed: ReadonlySet<string>, io: InitIo): InitResult {
  io.print(dryRun ? 'iris init (dry run — no files written)' : 'iris init');
  io.print('');
  let applied = 0;
  let manual = 0;
  for (const s of plan.steps) {
    // A side effect that failed to apply is reported as a manual step with its fallback command.
    const downgraded = failed.has(s.target);
    const status = downgraded ? StepStatus.MANUAL : s.status;
    const detail =
      downgraded && s.exec !== undefined
        ? `install failed — run manually: ${s.exec.fallback}`
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
    io.print('No package.json found. Run `iris init` from your project root.');
    return { ok: false, applied: 0, manual: 0 };
  }

  const plan = buildPlan(gatherPlanInput(options, io, pkgRaw));
  const failed = options.dryRun ? new Set<string>() : applyEffects(plan, io);
  return report(plan, options.dryRun, failed, io);
}
