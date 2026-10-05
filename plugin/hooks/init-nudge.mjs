/**
 * SessionStart: tell the agent, once per project, that this web app has Reticle's tools but was
 * never wired to them.
 *
 * The plugin registers the MCP server and stops. The step that makes the tools useful — `init` in
 * the app — is a separate act, and the MCP server's own "run init first" instruction is only read
 * once the agent calls a Reticle tool, which an agent never does unprompted. So most plugin installs
 * sat with an attached agent and no app, and never got a verdict. This puts the missing step in
 * front of the agent at the start of the session instead of waiting for a task that names Reticle.
 *
 * Never fails the session: any error, or any doubt about the project, prints nothing and exits 0.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG_FILE = '.reticle.json';
const SDK_SCOPE = '@reticlehq/';
// ponytail: root package.json only. A monorepo whose apps live in workspaces is not nudged; `init`
// handles that case itself, so widen this only if the plugin cohort's init rate stays flat.
const WEB_DEPS = [
  'react',
  'next',
  'vue',
  'nuxt',
  'svelte',
  '@sveltejs/kit',
  'vite',
  'astro',
  '@angular/core',
  'solid-js',
  'preact',
  '@remix-run/react',
  'react-router',
  '@tanstack/react-start',
];
const STATE_DIR = process.env['RETICLE_STATE_DIR'] ?? join(homedir(), '.reticle');
const NUDGED_FILE = join(STATE_DIR, 'plugin-init-nudged.json');

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** The server version this plugin pins, so `init` installs an SDK that speaks the same contract. */
function pinnedServer() {
  const manifest = readJson(
    join(dirname(fileURLToPath(import.meta.url)), '..', '.claude-plugin', 'plugin.json'),
  );
  const args = manifest?.mcpServers?.reticle?.args ?? [];
  return (
    args.find((a) => 'string' === typeof a && a.startsWith('@reticlehq/server')) ??
    '@reticlehq/server@latest'
  );
}

function needsNudge(cwd) {
  const pkg = readJson(join(cwd, 'package.json'));
  if (null === pkg || existsSync(join(cwd, CONFIG_FILE))) return false;
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  if (deps.some((d) => d.startsWith(SDK_SCOPE))) return false;
  return deps.some((d) => WEB_DEPS.includes(d));
}

function main() {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    // No stdin: fall back to the process directory.
  }
  const cwd = 'string' === typeof input.cwd ? input.cwd : process.cwd();
  if (!needsNudge(cwd)) return;

  const key = createHash('sha256').update(cwd).digest('hex').slice(0, 16);
  const nudged = readJson(NUDGED_FILE);
  const seen = Array.isArray(nudged) ? nudged : [];
  if (seen.includes(key)) return;

  const command = `RETICLE_INSTALL_SOURCE=plugin npx -y ${pinnedServer()} init`;
  const context =
    'Reticle is installed (plugin) but this web app is not wired to it yet, so no reticle_* tool ' +
    'can see or verify anything here. In your first reply, tell the user this in one line and offer ' +
    `to run \`${command}\` in this directory: it adds a dev-only SDK, wires the build config, starts ` +
    'the dev server and opens the app. Run it only if they agree; if they decline, do not raise it again.';
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
    }),
  );

  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(NUDGED_FILE, JSON.stringify([...seen, key]));
}

try {
  main();
} catch {
  // A nudge is never worth a broken session.
}
