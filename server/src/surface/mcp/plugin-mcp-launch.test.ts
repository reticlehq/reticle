/**
 * The Claude Code plugin's MCP command, and the local copy of the server it starts from.
 *
 * The plugin started `npx -y @reticlehq/server@<version> mcp`. Each start asked npm for the package
 * while the agent waited, and the first start downloaded all of it, so a slow registry made the
 * server miss the client's start timeout. The plugin now starts a pinned copy in
 * `${CLAUDE_PLUGIN_DATA}`, and it uses the same npx command only when that copy is not there yet.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '@/machine/repo-root.js';
import { PLUGIN_SERVER_DIR } from '@/telemetry/agent-client.js';

const PLUGIN = join(REPO_ROOT, 'plugins', 'reticle');
const SCRIPT = join(PLUGIN, 'scripts', 'mcp-server.mjs');
const MANIFEST = join(PLUGIN, '.claude-plugin', 'plugin.json');
const HOOK = join(PLUGIN, 'hooks', 'init-nudge.mjs');

type Command =
  { kind: 'local'; entry: string } | { kind: 'npx'; file: string; args: string[]; shell: boolean };

interface NpmRun {
  file: string;
  args: string[];
  options: { cwd: string; timeout: number; shell: boolean };
}

interface Launcher {
  SERVER_DIR: string;
  INSTALL_TIMEOUT_MS: number;
  pinnedVersion: () => string;
  localEntry: (dataDir: string, version: string) => string;
  serverCommand: (input: {
    dataDir: string | undefined;
    version: string;
    platform: string;
  }) => Command;
  npmInstall: (staging: string, version: string, platform: string) => NpmRun;
  populate: (input: {
    dataDir: string;
    version: string;
    install: (run: NpmRun) => boolean;
  }) => boolean;
  START_LOG: string;
  npxExitReason: (input: {
    code: number | null;
    signal: string | null;
    forwarded: boolean;
  }) => string | undefined;
  recordStartFailure: (input: {
    dataDir: string | undefined;
    version: string;
    reason: string;
    command: string;
    stderr: { write: (line: string) => void };
    now: () => number;
  }) => string | undefined;
}

interface StartRecord {
  at: string;
  version: string;
  node: string;
  platform: string;
  reason: string;
  command: string;
}

function startRecords(dataDir: string, log: string): StartRecord[] {
  return readFileSync(join(dataDir, log), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as StartRecord);
}

function captureStderr(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

async function launcher(): Promise<Launcher> {
  return (await import(pathToFileURL(SCRIPT).href)) as Launcher;
}

function manifestVersion(): string {
  const parsed = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { version: string };
  return parsed.version;
}

/** A fake server package: its bin prints the arguments it was given and exits. */
function fakeServer(dataDir: string, version: string, entry: string): void {
  mkdirSync(join(entry, '..'), { recursive: true });
  writeFileSync(entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  expect(entry.startsWith(join(dataDir, PLUGIN_SERVER_DIR, version))).toBe(true);
}

describe('the plugin MCP command', () => {
  it('starts node on the bundled launcher, with no npx and no second version string', () => {
    const text = readFileSync(MANIFEST, 'utf8');
    const parsed = JSON.parse(text) as {
      mcpServers: { reticle: { command: string; args: string[] } };
    };
    expect(parsed.mcpServers.reticle.command).toBe('node');
    expect(parsed.mcpServers.reticle.args).toEqual([
      '${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs',
    ]);
    // The manifest `version` is the one pin. A release bumps it, and the launcher reads it.
    expect(text).not.toContain('@reticlehq/server@');
  });

  it('pins the version that plugin.json declares', async () => {
    const mod = await launcher();
    expect(mod.pinnedVersion()).toBe(manifestVersion());
  });

  it('uses the same directory name as the server, which reads it to classify the launch', async () => {
    const mod = await launcher();
    expect(mod.SERVER_DIR).toBe(PLUGIN_SERVER_DIR);
  });

  it('starts the local copy when it is there', async () => {
    const mod = await launcher();
    const dataDir = mkdtempSync(join(tmpdir(), 'reticle-plugin-data-'));
    const entry = mod.localEntry(dataDir, '9.9.9');
    fakeServer(dataDir, '9.9.9', entry);
    expect(mod.serverCommand({ dataDir, version: '9.9.9', platform: 'darwin' })).toEqual({
      kind: 'local',
      entry,
    });
  });

  it('falls back to the pinned npx command when the local copy is not there', async () => {
    const mod = await launcher();
    const dataDir = mkdtempSync(join(tmpdir(), 'reticle-plugin-data-'));
    expect(mod.serverCommand({ dataDir, version: '9.9.9', platform: 'linux' })).toEqual({
      kind: 'npx',
      file: 'npx',
      args: ['-y', '@reticlehq/server@9.9.9', 'mcp'],
      shell: false,
    });
    expect(mod.serverCommand({ dataDir: undefined, version: '9.9.9', platform: 'darwin' })).toEqual(
      { kind: 'npx', file: 'npx', args: ['-y', '@reticlehq/server@9.9.9', 'mcp'], shell: false },
    );
  });

  it('starts npx.cmd through a shell on Windows, where a .cmd cannot start without one', async () => {
    const mod = await launcher();
    expect(mod.serverCommand({ dataDir: undefined, version: '9.9.9', platform: 'win32' })).toEqual({
      kind: 'npx',
      file: 'npx.cmd',
      args: ['-y', '@reticlehq/server@9.9.9', 'mcp'],
      shell: true,
    });
  });

  it('runs the local copy as `mcp`, in the same process', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'reticle-plugin-data-'));
    const version = manifestVersion();
    const entry = join(
      dataDir,
      PLUGIN_SERVER_DIR,
      version,
      'node_modules',
      '@reticlehq',
      'server',
      'bin',
      'reticle.js',
    );
    fakeServer(dataDir, version, entry);
    const out = spawnSync(process.execPath, [SCRIPT], {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
      encoding: 'utf8',
    });
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual(['mcp']);
  });
});

describe('the local copy is filled once, within a time limit', () => {
  it('runs npm in its own folder with a time limit', async () => {
    const mod = await launcher();
    const run = mod.npmInstall('/data/staging', '9.9.9', 'darwin');
    expect(run.file).toBe('npm');
    expect(run.args).toContain('@reticlehq/server@9.9.9');
    expect(run.options.cwd).toBe('/data/staging');
    expect(run.options.timeout).toBe(mod.INSTALL_TIMEOUT_MS);
    expect(run.options.timeout).toBeGreaterThan(0);
    expect(run.options.shell).toBe(false);
    // On Windows npm is a .cmd. No path goes on the command line, so the shell parses nothing odd.
    const windows = mod.npmInstall('C:/Users/A B/data/staging', '9.9.9', 'win32');
    expect(windows.file).toBe('npm.cmd');
    expect(windows.options.shell).toBe(true);
    expect(windows.args.join(' ')).not.toContain('A B');
  });

  it('installs into the version folder, and does nothing when it is already there', async () => {
    const mod = await launcher();
    const dataDir = mkdtempSync(join(tmpdir(), 'reticle-plugin-data-'));
    let runs = 0;
    const install = (run: NpmRun): boolean => {
      runs += 1;
      const bin = join(run.options.cwd, 'node_modules', '@reticlehq', 'server', 'bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'reticle.js'), '');
      return true;
    };
    expect(mod.populate({ dataDir, version: '9.9.9', install })).toBe(true);
    expect(existsSync(mod.localEntry(dataDir, '9.9.9'))).toBe(true);
    expect(mod.populate({ dataDir, version: '9.9.9', install })).toBe(true);
    expect(runs).toBe(1);
    // Only the finished version folder stays. The staging folder is gone.
    expect(readdirSync(join(dataDir, PLUGIN_SERVER_DIR))).toEqual(['9.9.9']);
  });

  it('leaves no copy and no staging folder when npm fails', async () => {
    const mod = await launcher();
    const dataDir = mkdtempSync(join(tmpdir(), 'reticle-plugin-data-'));
    expect(mod.populate({ dataDir, version: '9.9.9', install: () => false })).toBe(false);
    expect(existsSync(mod.localEntry(dataDir, '9.9.9'))).toBe(false);
    expect(readdirSync(join(dataDir, PLUGIN_SERVER_DIR))).toEqual([]);
  });

  it('leaves no copy when npm says it succeeded but wrote no server', async () => {
    const mod = await launcher();
    const dataDir = mkdtempSync(join(tmpdir(), 'reticle-plugin-data-'));
    expect(mod.populate({ dataDir, version: '9.9.9', install: () => true })).toBe(false);
    expect(readdirSync(join(dataDir, PLUGIN_SERVER_DIR))).toEqual([]);
  });
});

// #2452: the launcher runs before the server, so a start that failed here left no reason anywhere.
describe('a start that fails leaves its reason', () => {
  it('records a local copy that does not load, and prints one line on stderr', async () => {
    const mod = await launcher();
    const dataDir = mkdtempSync(join(tmpdir(), 'reticle-plugin-data-'));
    const version = manifestVersion();
    const entry = mod.localEntry(dataDir, version);
    mkdirSync(join(entry, '..'), { recursive: true });
    writeFileSync(entry, "import './missing-chunk.js';\n");
    const out = spawnSync(process.execPath, [SCRIPT], {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir },
      encoding: 'utf8',
    });
    expect(out.status).toBe(1);
    const records = startRecords(dataDir, mod.START_LOG);
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.reason).toContain('the local copy did not load');
    expect(record?.reason).toContain('missing-chunk.js');
    expect(record?.version).toBe(version);
    expect(record?.node).toBe(process.version);
    expect(record?.command).toContain(entry);
    const stderrLines = out.stderr.split('\n').filter((line) => line.startsWith('reticle:'));
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toContain('the local copy did not load');
    expect(stderrLines[0]).toContain(join(dataDir, mod.START_LOG));
  });

  it('appends one line for each failure, with the time from the injected clock', async () => {
    const mod = await launcher();
    const dataDir = mkdtempSync(join(tmpdir(), 'reticle-plugin-data-'));
    const stderr = captureStderr();
    const base = {
      dataDir,
      version: '9.9.9',
      command: 'npx -y @reticlehq/server@9.9.9 mcp',
      stderr,
    };
    const path = mod.recordStartFailure({
      ...base,
      reason: 'npx exited with code 1',
      now: () => 0,
    });
    mod.recordStartFailure({
      ...base,
      reason: 'npx did not start: spawn npx ENOENT',
      now: () => 1000,
    });
    expect(path).toBe(join(dataDir, mod.START_LOG));
    const records = startRecords(dataDir, mod.START_LOG);
    expect(records.map((r) => r.reason)).toEqual([
      'npx exited with code 1',
      'npx did not start: spawn npx ENOENT',
    ]);
    expect(records.map((r) => r.at)).toEqual([
      '1970-01-01T00:00:00.000Z',
      '1970-01-01T00:00:01.000Z',
    ]);
    expect(stderr.lines).toHaveLength(2);
    expect(stderr.lines[0]).toContain('npx exited with code 1');
  });

  it('still prints the reason when there is no data folder, or the log cannot be written', async () => {
    const mod = await launcher();
    const base = {
      version: '9.9.9',
      reason: 'npx exited with code 1',
      command: 'npx',
      now: () => 0,
    };
    const none = captureStderr();
    expect(mod.recordStartFailure({ ...base, dataDir: undefined, stderr: none })).toBeUndefined();
    expect(none.lines).toHaveLength(1);
    expect(none.lines[0]).not.toContain('Log:');
    // A file where the folder should be: the log write fails, and the reason still shows.
    const blocked = join(mkdtempSync(join(tmpdir(), 'reticle-plugin-data-')), 'not-a-folder');
    writeFileSync(blocked, '');
    const refused = captureStderr();
    expect(mod.recordStartFailure({ ...base, dataDir: blocked, stderr: refused })).toBeUndefined();
    expect(refused.lines[0]).toContain('npx exited with code 1');
  });

  it('names an npx exit as a failure, but not a normal stop or a signal from the client', async () => {
    const mod = await launcher();
    expect(mod.npxExitReason({ code: 0, signal: null, forwarded: false })).toBeUndefined();
    expect(mod.npxExitReason({ code: 1, signal: null, forwarded: false })).toBe(
      'npx exited with code 1',
    );
    expect(mod.npxExitReason({ code: null, signal: 'SIGTERM', forwarded: true })).toBeUndefined();
    expect(mod.npxExitReason({ code: null, signal: 'SIGKILL', forwarded: false })).toBe(
      'npx stopped on signal SIGKILL',
    );
  });
});

describe('the SessionStart offer names the pinned server', () => {
  it('reads the pin from the manifest version, not from the MCP args', () => {
    const app = mkdtempSync(join(tmpdir(), 'reticle-launch-app-'));
    writeFileSync(join(app, 'package.json'), JSON.stringify({ devDependencies: { vite: '6' } }));
    const out = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ cwd: app }),
      env: { ...process.env, RETICLE_STATE_DIR: mkdtempSync(join(tmpdir(), 'reticle-launch-')) },
      encoding: 'utf8',
    });
    expect(out.stdout).toContain(`npx -y @reticlehq/server@${manifestVersion()} init`);
  });
});
