/**
 * The real (Node filesystem) implementation of `InitIo`. Kept separate from the pure runner so
 * `runInit` stays testable with an in-memory IO. Prints to stdout — `init` is a one-shot CLI
 * command, not the MCP stdio transport.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import type { InitIo } from './run.js';

export function buildNodeIo(cwd: string): InitIo {
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
    rootFiles() {
      return readdirSync(cwd).filter((name) => {
        try {
          return statSync(join(cwd, name)).isFile();
        } catch {
          return false;
        }
      });
    },
    exec(command, args) {
      // `shell: true` lets package-manager shims (pnpm.cmd, etc.) resolve on Windows; inherit
      // stdio so the install's own progress is visible to the user.
      const result = spawnSync(command, [...args], { cwd, stdio: 'inherit', shell: true });
      return result.status === 0;
    },
    probe(command, args) {
      // Quiet yes/no check (CLI availability, existing registration). Never throws.
      const result = spawnSync(command, [...args], { cwd, stdio: 'ignore', shell: true });
      return result.status === 0;
    },
    print(line) {
      process.stdout.write(`${line}\n`);
    },
  };
}
