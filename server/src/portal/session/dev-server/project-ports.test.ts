/** An app whose port is set only in `.env` was invisible to the no-session scan (reticle#1543). */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envFilePorts } from './project-ports.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'reticle-project-ports-'));
  dirs.push(dir);
  return dir;
}

describe('the ports a project sets in its .env files', () => {
  it('reads PORT=3020 from .env', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '.env'), 'API_URL=http://localhost:8000\nPORT=3020\n', 'utf8');
    expect(envFilePorts(dir)).toEqual([3020]);
  });

  it('accepts export, quotes and a trailing comment, across every .env file', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '.env.local'), 'export PORT="4100" # preview\n', 'utf8');
    writeFileSync(join(dir, '.env.development'), "PORT='4200'\n", 'utf8');
    expect(envFilePorts(dir).sort()).toEqual([4100, 4200]);
  });

  it('ignores other keys that end in PORT, and values that are not a port', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '.env'), 'DB_PORT=5432\nPORT=70000\nPORT=abc\n# PORT=1234\n', 'utf8');
    expect(envFilePorts(dir)).toEqual([]);
  });

  it('returns nothing when the project has no .env file', () => {
    expect(envFilePorts(tempDir())).toEqual([]);
  });
});
