/**
 * The real (Node filesystem) implementation of `InitIo`. Kept separate from the pure runner so
 * `runInit` stays testable with an in-memory IO. Prints to stdout — `init` is a one-shot CLI
 * command, not the MCP stdio transport.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  accessSync,
  constants,
} from 'node:fs';
import { NodePlatform } from './detect/platform.js';
import { join, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import type { InitIo } from './run.js';
import type { InitHost } from './host.js';
import { windowsShellArg } from './register/windows-quote.js';

/**
 * `shell: true` ONLY where it earns its keep.
 *
 * It exists so package-manager shims (`pnpm.cmd`, `npx.cmd`) resolve on Windows. On POSIX it buys
 * nothing and costs correctness: under a shell, arguments are re-parsed, so a path containing a
 * space — `/Users/ada/My Projects/app` — silently becomes two arguments and registration fails with
 * no error anyone can read.
 */
function shellOpt(): { shell?: true } {
  return NodePlatform.WINDOWS === process.platform ? { shell: true } : {};
}

/**
 * Under a shell, quote what the shell would otherwise split or interpret. Windows only, where
 * `shell: true` is required (see shellOpt). The rule itself lives in windows-quote.ts as a pure
 * function so it can be tested on every platform — keeping it inside this branch is why it was
 * wrong for as long as it was.
 */
function shellSafe(args: readonly string[]): string[] {
  if (process.platform !== NodePlatform.WINDOWS) return [...args];
  return args.map(windowsShellArg);
}

/**
 * Every program `init` is ever allowed to run.
 *
 * The set is closed and tiny — the four package managers, `npx`, and the Claude CLI — because those
 * are the only things the plan can ask for. It is a named constant for the same reason every other
 * wire string here is one, and it is CHECKED because of `shellOpt`: on Windows these spawn through
 * a shell, and a shell turns the command name into something the shell parses rather than a file it
 * executes. Arguments are quoted by `shellSafe`; the command name was the half nothing covered.
 *
 * A command outside this set is a programming error — the plan built something no branch of this
 * package can produce — so it throws rather than returning `false`, which would read to the caller
 * as "the command ran and failed" and hide the bug in a retry.
 */
export const RUNNABLE_COMMANDS: readonly string[] = ['pnpm', 'yarn', 'bun', 'npm', 'npx', 'claude'];

/** The command, proven to be one of `RUNNABLE_COMMANDS` — never the caller's string. */
function runnable(command: string): string {
  const found = RUNNABLE_COMMANDS.find((allowed) => allowed === command);
  if (undefined === found) {
    throw new Error(
      `init refused to run ${JSON.stringify(command)}: not one of ${RUNNABLE_COMMANDS.join(', ')}.`,
    );
  }
  return found;
}

export function buildNodeIo(cwd: string, host: InitHost): InitIo {
  // Project-relative by default; absolute paths (e.g. ~/.cursor/mcp.json) pass through unchanged.
  const abs = (rel: string): string => (isAbsolute(rel) ? rel : join(cwd, rel));
  return {
    readFile(rel) {
      const path = abs(rel);
      if (!existsSync(path)) return null;
      return readFileSync(path, 'utf8');
    },
    writeFile(rel, content) {
      const path = abs(rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, 'utf8');
    },
    exists(rel) {
      return existsSync(abs(rel));
    },
    homeDir() {
      return homedir();
    },
    cwd() {
      return cwd;
    },
    rootFiles() {
      return readdirSync(cwd).filter((name) => {
        try {
          return statSync(join(cwd, name)).isFile();
        } catch {
          return false;
        }
      });
    },
    listDirs(rel) {
      const path = abs(rel);
      if (!existsSync(path)) return [];
      try {
        return readdirSync(path).filter((name) => statSync(join(path, name)).isDirectory());
      } catch {
        return [];
      }
    },
    listFiles(rel) {
      const path = abs(rel);
      if (!existsSync(path)) return [];
      try {
        return readdirSync(path).filter((name) => !statSync(join(path, name)).isDirectory());
      } catch {
        return [];
      }
    },
    scoped(rel) {
      // The host travels with the re-rooted IO: a monorepo redirect re-enters `runInit` through
      // this, and an untraced, unreported inner run is the half of init that actually did the work.
      return buildNodeIo(abs(rel), host);
    },
    exec(command, args) {
      // Inherit stdio so the install's own progress is visible to the user.
      const result = spawnSync(runnable(command), shellSafe(args), {
        cwd,
        stdio: 'inherit',
        ...shellOpt(),
      });
      return 0 === result.status;
    },
    /** One access check, rather than discovering it as an EACCES stack four phases later. */
    canWrite() {
      try {
        accessSync(cwd, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    probe(command, args) {
      // Quiet yes/no check (CLI availability, existing registration). Never throws.
      const result = spawnSync(runnable(command), shellSafe(args), {
        cwd,
        stdio: 'ignore',
        ...shellOpt(),
      });
      return 0 === result.status;
    },
    print(line) {
      process.stdout.write(`${line}\n`);
    },
    host,
  };
}
