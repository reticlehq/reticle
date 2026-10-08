/**
 * Wiring the app the first time an agent needs it, instead of at installation.
 *
 * Installing Reticle puts a CLI and an MCP server on the machine and touches no project. The app is
 * instrumented the first time an agent actually uses Reticle against it: the daemon runs its own
 * CLI's `init` in the project directory, the same codemod, dev-server start and connect a person
 * would have run by hand, and reports what it changed.
 *
 * A child process rather than an import: the daemon never imports `@reticlehq/init`
 * (library-path-boundary.test.ts), and running the CLI keeps that line where it is.
 *
 * Once per directory for the life of the daemon. A second call returns the first answer, so an agent
 * that asks again after a failure is told the same thing rather than re-running a codemod on files
 * the first run already changed.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isWebApp } from '@reticlehq/init';
import { readProjectId } from '@/command/cli/ports/resolve/cli-port.js';

/** init has a dev server to start and a page to wait for; past this it is not coming. */
const WIRE_TIMEOUT_MS = 120_000;
/** A plan line as init prints it: `[✓] Vite plugin → vite.config.ts`. */
const PLAN_LINE = /^\s*\[(.)\]\s+(.+?)\s+→\s+(.+)$/;

export interface WiredStep {
  mark: string;
  title: string;
  target: string;
}

export interface WireOutcome {
  ok: boolean;
  /** Where init ran. */
  directory: string;
  /** Every step of init's plan, applied or not, as it printed them. */
  steps: WiredStep[];
  /** The app's url, when init got as far as the dev server. */
  url?: string;
  /** Why it stopped, in init's words or ours. */
  error?: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunCli = (args: readonly string[], cwd: string) => Promise<RunResult>;

export interface FirstRunWiring {
  /**
   * The directory init would run in, or undefined when it cannot be told without guessing: a
   * daemon started in the home directory or at a filesystem root has no project of its own.
   */
  projectDirectory(cwd: string): string | undefined;
  wire(directory: string): Promise<WireOutcome>;
}

export function projectDirectoryOf(
  cwd: string,
  home = homedir(),
  wired: (dir: string) => boolean = (dir) => readProjectId(dir) !== undefined,
): string | undefined {
  const dir = resolve(cwd);
  if (dir === resolve(home) || dir === resolve('/')) return undefined;
  // Already wired: nothing for a first run to do, and init over a wired app proves nothing.
  if (wired(dir)) return undefined;
  // Only an app with a page: a daemon started in a library or API package wrote a config there.
  return isWebApp('.', {
    exists: (p) => existsSync(join(dir, p)),
    readFile: (p) => {
      try {
        return readFileSync(join(dir, p), 'utf8');
      } catch {
        return null;
      }
    },
  })
    ? dir
    : undefined;
}

/** init's plan lines, and the one JSON object it prints last under `--json`. */
export function readInitOutput(stdout: string): { steps: WiredStep[]; result: unknown } {
  const steps = stdout
    .split('\n')
    .map((line) => PLAN_LINE.exec(line))
    .flatMap((m) =>
      null === m
        ? []
        : [{ mark: m[1] ?? '', title: (m[2] ?? '').trim(), target: (m[3] ?? '').trim() }],
    );
  const at = stdout.lastIndexOf('\n{\n') + 1;
  let result: unknown;
  try {
    result = JSON.parse(stdout.slice(at));
  } catch {
    result = undefined;
  }
  return { steps, result };
}

function nodeRun(cliPath: string): RunCli {
  return (args, cwd) =>
    new Promise((done) => {
      const child = spawn(process.execPath, [cliPath, ...args], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      const timer = setTimeout(() => child.kill(), WIRE_TIMEOUT_MS);
      child.on('error', (error) => {
        clearTimeout(timer);
        done({ code: 1, stdout, stderr: `${stderr}${error.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        done({ code: code ?? 1, stdout, stderr });
      });
    });
}

export function firstRunWiring(options: {
  /** This daemon's port, so init wires the app to it rather than choosing another. */
  port: number;
  cliPath: string;
  run?: RunCli;
}): FirstRunWiring {
  const run = options.run ?? nodeRun(options.cliPath);
  const done = new Map<string, Promise<WireOutcome>>();
  return {
    projectDirectory: (cwd) => projectDirectoryOf(cwd),
    wire(directory) {
      const held = done.get(directory);
      if (held !== undefined) return held;
      const outcome = run(['init', '--no-mcp', '--json', '--port', String(options.port)], directory)
        .then(({ code, stdout, stderr }): WireOutcome => {
          // Under --json the plan lines may go to stderr, keeping stdout for the one object.
          const { result } = readInitOutput(stdout);
          const { steps } = readInitOutput(`${stdout}\n${stderr}`);
          const record =
            'object' === typeof result && null !== result
              ? (result as Record<string, unknown>)
              : {};
          const url = 'string' === typeof record['url'] ? record['url'] : undefined;
          const ok = 0 === code && true === record['ok'];
          const lastError = stderr.trim().split('\n').at(-1);
          return {
            ok,
            directory,
            steps,
            ...(url === undefined ? {} : { url }),
            ...(ok
              ? {}
              : {
                  error:
                    lastError !== undefined && 0 < lastError.length
                      ? lastError
                      : `init exited ${String(code)}`,
                }),
          };
        })
        .catch((error: unknown): WireOutcome => ({
          ok: false,
          directory,
          steps: [],
          error: error instanceof Error ? error.message : String(error),
        }));
      done.set(directory, outcome);
      return outcome;
    },
  };
}
