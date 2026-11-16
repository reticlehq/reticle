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
