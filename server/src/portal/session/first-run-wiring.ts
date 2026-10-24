/**
 * Which unwired web app a caller is in.
 *
 * Installing Reticle puts a CLI and an MCP server on the machine and touches no project. The
 * daemon never wires a project by itself: `init` changes the user's files, so it runs only when
 * the user agrees (the agent runs the command, or the user does). The daemon only finds the
 * unwired app, so that the first session call can offer the zero-install lease and the consent
 * question for it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isWebApp } from '@reticlehq/init';
import { readProjectId } from '@/command/cli/ports/resolve/cli-port.js';

export interface FirstRunWiring {
  /**
   * The unwired web app at `cwd`, or undefined when it cannot be told without guessing: a daemon
   * started in the home directory or at a filesystem root has no project of its own.
   */
  projectDirectory(cwd: string): string | undefined;
}

export function projectDirectoryOf(
  cwd: string,
  home = homedir(),
  wired: (dir: string) => boolean = (dir) => readProjectId(dir) !== undefined,
): string | undefined {
  const dir = resolve(cwd);
  if (dir === resolve(home) || dir === resolve('/')) return undefined;
  // Already wired: there is no step to offer.
  if (wired(dir)) return undefined;
  // Only an app with a page: a library or an API package has nothing to lease or to wire.
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

export function firstRunWiring(): FirstRunWiring {
  return { projectDirectory: (cwd) => projectDirectoryOf(cwd) };
}
