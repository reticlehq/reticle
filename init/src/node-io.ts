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
 * Under a shell, quote what the shell would otherwise split or interpret. Windows only, where
 * `shell: true` is required (see spawnAllowed). The rule itself lives in windows-quote.ts as a pure
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
 * wire string here is one, and it is CHECKED because of the shell: on Windows these spawn through
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

/**
 * Every spawn `init` makes, in the one shape Node does not deprecate.
 *
 * Passing an args ARRAY together with `shell: true` is DEP0190, and on Windows — the only platform
 * where this turns the shell on — every single `init` and `curl | sh` install printed this
 * into the middle of its output:
 *
 *   [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead
 *   to security vulnerabilities, as the arguments are not escaped, only concatenated.
 *
 * A security warning in the middle of an install is a bad first thing to show somebody, and on the
 * platform with the most users it was every install. The deprecation is also RIGHT about the
 * reason: Node does not escape, it concatenates. We already escape — `windowsShellArg` implements
 * the `CommandLineToArgvW` rule and is tested on every platform — so the fix is to own the
 * concatenation rather than hand Node an array it will join unsafely. Same command line, same
 * quoting, no warning.
 *
 * POSIX keeps the array and no shell, where argv is passed through untouched and a path with a
 * space cannot be re-split.
 */
function spawnAllowed(
  command: string,
  args: readonly string[],
  options: { cwd?: string; stdio: 'inherit' | 'ignore' },
): ReturnType<typeof spawnSync> {
  const name = runnable(command);
  if (NodePlatform.WINDOWS !== process.platform) {
    return spawnSync(name, [...args], options);
  }
  // The name is one of RUNNABLE_COMMANDS, so it never needs quoting itself.
  return spawnSync([name, ...shellSafe(args)].join(' '), [], { ...options, shell: true });
}

/**
 * Run one allowed CLI quietly and say whether it succeeded — the `probe` above, without an `InitIo`.
 *
 * Exported because `reticle setup mcp` needs exactly this and had reimplemented it as a bare
 * `execFileSync(command, args)`. That works everywhere except Windows, where `claude` is a `.cmd`
 * shim that cannot be spawned without a shell: the probe threw ENOENT, the installer concluded the
 * machine had no Claude Code on it, and said so. The three rules that make this correct —
 * `runnable`, `shellSafe` and the shell decision — already lived here and were private, which is the whole
 * reason a second, broken copy existed.
 */
export function probeCli(command: string, args: readonly string[]): boolean {
  try {
    const result = spawnAllowed(command, args, { stdio: 'ignore' });
    return 0 === result.status;
  } catch {
    return false;
  }
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
      const result = spawnAllowed(command, args, { cwd, stdio: 'inherit' });
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
      const result = spawnAllowed(command, args, { cwd, stdio: 'ignore' });
      return 0 === result.status;
    },
    print(line) {
      process.stdout.write(`${line}\n`);
    },
    host,
  };
}
