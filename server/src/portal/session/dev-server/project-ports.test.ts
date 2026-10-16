/**
 * An app whose port no `dev` script names was invisible to the no-session scan (reticle#1543).
 *
 * Reported: a preview server started by a Node script listened on :3020, with the port set in code
 * and `.env`. The answer said no app was running and suggested starting a dev server, which would
 * start a duplicate. These pin the two sources that now add such a port to the scan.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  envFilePorts,
  parseLsofCwd,
  parseLsofListeners,
  projectListenerPorts,
  systemListenerProbe,
} from './project-ports.js';
import type { ListenerProbe, ProcessListener } from './project-ports.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'reticle-project-ports-'));
  dirs.push(dir);
  return dir;
}

function fakeProbe(
  listeners: readonly ProcessListener[],
  cwds: Readonly<Record<number, string>>,
): ListenerProbe {
  return {
    listeners: () => Promise.resolve(listeners),
    cwdOf: (pid) => Promise.resolve(cwds[pid]),
  };
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

describe('the ports that processes inside the project listen on', () => {
  it('adds the port of a listener whose process runs inside the project', async () => {
    const project = tempDir();
    mkdirSync(join(project, 'scripts'));
    const elsewhere = tempDir();
    const probe = fakeProbe(
      [
        { pid: 10, port: 3020 },
        { pid: 11, port: 5000 },
      ],
      { 10: join(project, 'scripts'), 11: elsewhere },
    );
    expect(await projectListenerPorts(project, probe)).toEqual([3020]);
  });

  it('does not take a sibling directory with a shared prefix as inside the project', async () => {
    const parent = tempDir();
    mkdirSync(join(parent, 'app'));
    mkdirSync(join(parent, 'app-other'));
    const probe = fakeProbe([{ pid: 12, port: 3030 }], { 12: join(parent, 'app-other') });
    expect(await projectListenerPorts(join(parent, 'app'), probe)).toEqual([]);
  });

  it('adds nothing when a working directory cannot be read', async () => {
    const probe = fakeProbe([{ pid: 13, port: 3040 }], {});
    expect(await projectListenerPorts(tempDir(), probe)).toEqual([]);
  });

  it('adds nothing, and does not throw, when listing listeners fails', async () => {
    const probe: ListenerProbe = {
      listeners: () => Promise.reject(new Error('lsof: not found')),
      cwdOf: () => Promise.resolve(undefined),
    };
    expect(await projectListenerPorts(tempDir(), probe)).toEqual([]);
  });
});

describe('reading lsof output', () => {
  it('pairs every listening address with the process listed before it', () => {
    const output = [
      'p501',
      'f20',
      'n127.0.0.1:3020',
      'f21',
      'n[::1]:3020',
      'p777',
      'f9',
      'n*:8080',
      '',
    ].join('\n');
    expect(parseLsofListeners(output)).toEqual([
      { pid: 501, port: 3020 },
      { pid: 501, port: 3020 },
      { pid: 777, port: 8080 },
    ]);
  });

  it('reads the working directory from the n line', () => {
    expect(parseLsofCwd('p501\nfcwd\nn/home/dev/app\n')).toBe('/home/dev/app');
    expect(parseLsofCwd('p501\n')).toBeUndefined();
  });
});

describe('the platform probe', () => {
  it('is off on Windows, which has no way to name a working directory', () => {
    expect(systemListenerProbe('win32')).toBeUndefined();
  });

  it('is available on Linux and macOS', () => {
    expect(systemListenerProbe('linux')).toBeDefined();
    expect(systemListenerProbe('darwin')).toBeDefined();
  });
});
