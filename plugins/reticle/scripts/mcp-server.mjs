/**
 * The plugin's MCP server command: start the pinned Reticle server from a local copy.
 *
 * `npx -y @reticlehq/server@<version> mcp` asks npm for the package on each start while the agent
 * waits, and the first start downloads all of it. A slow registry can make the server miss the
 * client's start timeout. So the plugin keeps one copy of the pinned version in
 * `${CLAUDE_PLUGIN_DATA}` (a folder that Claude Code keeps across plugin updates) and starts it
 * with no network.
 *
 * When the copy is not there yet, this runs the same npx command as before, and starts a
 * background install of the copy for the next start. So a start is never slower than npx.
 *
 * The version is the `version` in `.claude-plugin/plugin.json`. A release bumps only that field.
 *
 * `server/src/surface/mcp/plugin-mcp-launch.test.ts` tests this file.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PACKAGE = '@reticlehq/server';
/** The server reads this name to see that it runs from the plugin. Keep it the same as `PLUGIN_SERVER_DIR`. */
export const SERVER_DIR = 'reticle-plugin-server';
/** npm stops after this time. A slow install then fails, and the next start tries again. */
export const INSTALL_TIMEOUT_MS = 180_000;
/** The background install waits this long, so it does not compete with the npx start for the network. */
const INSTALL_DELAY_MS = 30_000;
const MCP_COMMAND = 'mcp';
const POPULATE_COMMAND = 'populate';
const WINDOWS = 'win32';
const DATA_ENV = 'CLAUDE_PLUGIN_DATA';
const SELF = fileURLToPath(import.meta.url);

/** The server version that this plugin version pins. */
export function pinnedVersion() {
  const manifest = JSON.parse(
    readFileSync(join(dirname(SELF), '..', '.claude-plugin', 'plugin.json'), 'utf8'),
  );
  return manifest.version;
}

function versionDir(dataDir, version) {
  return join(dataDir, SERVER_DIR, version);
}

/** The `reticle` bin in the local copy of `version`. */
export function localEntry(dataDir, version) {
  return join(
    versionDir(dataDir, version),
    'node_modules',
    '@reticlehq',
    'server',
    'bin',
    'reticle.js',
  );
}

/** What to start: the local copy when it is complete, otherwise the pinned npx command. */
export function serverCommand({ dataDir, version, platform }) {
  if (undefined !== dataDir) {
    const entry = localEntry(dataDir, version);
    if (existsSync(entry)) {
      return { kind: 'local', entry };
    }
  }
  const windows = WINDOWS === platform;
  // ponytail: on Windows the shell parses these three tokens. None holds a space or a metacharacter.
  return {
    kind: 'npx',
    file: windows ? 'npx.cmd' : 'npx',
    args: ['-y', `${PACKAGE}@${version}`, MCP_COMMAND],
    shell: windows,
  };
}

/**
 * The npm command that installs `version` into `staging`. npm runs IN `staging`, which holds its own
 * package.json, so no path goes on the command line. On Windows `npm.cmd` needs a shell, and the
 * shell then has nothing to parse but fixed words.
 */
export function npmInstall(staging, version, platform) {
  const windows = WINDOWS === platform;
  return {
    file: windows ? 'npm.cmd' : 'npm',
    args: [
      'install',
      '--no-save',
      '--no-package-lock',
      '--no-audit',
      '--no-fund',
      '--prefer-offline',
      '--omit=dev',
      `${PACKAGE}@${version}`,
    ],
    options: { cwd: staging, timeout: INSTALL_TIMEOUT_MS, shell: windows },
  };
}

function runNpm(run) {
  const result = spawnSync(run.file, run.args, {
    ...run.options,
    stdio: 'ignore',
    windowsHide: true,
  });
  return 0 === result.status;
}

/**
 * Install the local copy of `version`, once. It installs into a staging folder and renames that
 * folder into place, so the copy is either complete or not there. Two sessions that install at the
 * same time both finish: the second rename fails and its staging folder is removed.
 * Returns true when the copy is there at the end.
 */
export function populate({ dataDir, version, install = runNpm }) {
  const target = versionDir(dataDir, version);
  if (existsSync(localEntry(dataDir, version))) {
    return true;
  }
  const root = join(dataDir, SERVER_DIR);
  const staging = join(root, `.staging-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, 'package.json'), '{"private":true}\n');
    const installed = install(npmInstall(staging, version, process.platform));
    const complete = existsSync(
      join(staging, 'node_modules', '@reticlehq', 'server', 'bin', 'reticle.js'),
    );
    if (installed && complete) {
      renameSync(staging, target);
    }
  } catch {
    // Another session renamed its copy first, or the disk refused. The next start tries again.
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return existsSync(localEntry(dataDir, version));
}

/** Start the background install. It continues after this process exits. */
function startPopulate() {
  try {
    const child = spawn(process.execPath, [SELF, POPULATE_COMMAND], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The next start tries again.
  }
}

async function startServer() {
  const dataDir = process.env[DATA_ENV];
  const command = serverCommand({ dataDir, version: pinnedVersion(), platform: process.platform });
  if ('local' === command.kind) {
    // The same process runs the server, so its own path is `process.argv[1]`, as with any bin.
    process.argv = [process.execPath, command.entry, MCP_COMMAND];
    await import(pathToFileURL(command.entry).href);
    return;
  }
  if (undefined !== dataDir) {
    startPopulate();
  }
  const child = spawn(command.file, command.args, { stdio: 'inherit', shell: command.shell });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('error', () => process.exit(1));
  child.on('exit', (code) => process.exit(code ?? 1));
}

function runPopulate() {
  const dataDir = process.env[DATA_ENV];
  if (undefined === dataDir) {
    return;
  }
  setTimeout(() => {
    populate({ dataDir, version: pinnedVersion() });
  }, INSTALL_DELAY_MS);
}

/** True when node runs this file, and false when a test imports it. */
function isMain() {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(SELF);
  } catch {
    return false;
  }
}

if (isMain()) {
  if (POPULATE_COMMAND === process.argv[2]) {
    runPopulate();
  } else {
    await startServer();
  }
}
