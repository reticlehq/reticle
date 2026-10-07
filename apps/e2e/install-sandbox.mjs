#!/usr/bin/env node
// The install, the way a user meets it: `curl -fsSL <install.sh> | sh` on a clean machine.
//
//   node apps/e2e/install-sandbox.mjs [--only <name>] [--no-publish]
//
// Every other install check runs on this machine, which already has Node, a warm npm cache, a
// Chromium, and Reticle's own state in ~/.reticle. A user has none of that. Each sandbox here is a
// fresh container: this checkout is published to a throwaway registry, install.sh is served to the
// container over HTTP, and the container runs the published one-liner against them, with no TTY, the
// way an agent runs it. What it printed is kept as the snapshot in artifacts/install-sandbox/.
//
// Needs Docker. Each image is a kind of machine users install on: a full Node, a slim one, Alpine's
// busybox sh, a Node too old to run Reticle, a machine with no Node at all, and one that ships a
// browser so the installer's demo can reach a verdict.

import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'artifacts', 'install-sandbox');
const REGISTRY_PORT = Number(process.env.SANDBOX_REGISTRY_PORT ?? '4875');
const SCRIPT_PORT = Number(process.env.SANDBOX_SCRIPT_PORT ?? '4876');
// Docker Desktop routes this name to the host's loopback, so nothing here listens beyond 127.0.0.1.
const HOST = 'host.docker.internal';
const REGISTRY = `http://127.0.0.1:${String(REGISTRY_PORT)}`;
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined;
const NO_PUBLISH = process.argv.includes('--no-publish');

/** What each kind of machine must do. `expect` is the contract the run is held to. */
const SANDBOXES = [
  { name: 'node22-debian', image: 'node:22-bookworm', expect: 'installs' },
  { name: 'node20-slim', image: 'node:20-bookworm-slim', prep: 'apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null', expect: 'installs' },
  { name: 'node24-alpine', image: 'node:24-alpine', prep: 'apk add --no-cache curl >/dev/null', expect: 'installs' },
  { name: 'node18-too-old', image: 'node:18-bookworm-slim', prep: 'apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null', expect: 'refuses', mustSay: /node/i },
  { name: 'no-node', image: 'ubuntu:24.04', prep: 'apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null', expect: 'refuses', mustSay: /node/i },
  { name: 'with-browser', image: 'mcr.microsoft.com/playwright:v1.63.0-noble', expect: 'installs', demo: /verified: yes/ },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

async function reachable(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

/** A registry holding this checkout's packages, and everything else proxied from npm. */
async function startRegistry() {
  const dir = mkdtempSync(join(tmpdir(), 'reticle-sandbox-verdaccio-'));
  const config = join(dir, 'verdaccio.yaml');
  writeFileSync(
    config,
    readFileSync(join(ROOT, 'scripts/verdaccio.yaml'), 'utf8').replace(
      'listen: 127.0.0.1:4873',
      `listen: 127.0.0.1:${String(REGISTRY_PORT)}`,
    ),
  );
  const bin = join(ROOT, 'apps/e2e/node_modules/verdaccio/bin/verdaccio');
  const proc = spawn(process.execPath, [bin, '--config', config], { cwd: ROOT, detached: true, stdio: 'ignore' });
  for (let i = 0; i < 180 && !(await reachable(`${REGISTRY}/-/ping`)); i++) await sleep(500);
  if (!(await reachable(`${REGISTRY}/-/ping`))) throw new Error(`verdaccio did not answer on ${REGISTRY}`);
  // A user per run: a registry left behind by a killed run already holds `reticle`, and a second
  // sign-up under that name returns no token.
  const user = `sandbox-${String(Date.now())}`;
  const res = await fetch(`${REGISTRY}/-/user/org.couchdb.user:${user}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ _id: `org.couchdb.user:${user}`, name: user, password: user, type: 'user', roles: [] }),
  });
  const token = (await res.json())?.token;
  if ('string' !== typeof token) throw new Error('no token from verdaccio');
  const npmrc = join(dir, '.npmrc');
  writeFileSync(npmrc, `registry=${REGISTRY}\n//127.0.0.1:${String(REGISTRY_PORT)}/:_authToken=${token}\n`);
  const env = { ...process.env, npm_config_userconfig: npmrc, NPM_CONFIG_USERCONFIG: npmrc };
  if (!NO_PUBLISH) {
    console.log('publishing this checkout to the sandbox registry…');
    run('npm', ['publish', '--registry', REGISTRY, '--provenance=false'], { cwd: join(ROOT, 'open-verification'), env });
    run('pnpm', ['-r', 'publish', '--registry', REGISTRY, '--no-git-checks'], { env, timeout: 15 * 60_000 });
  }
  return () => {
    try {
      process.kill(-proc.pid);
    } catch {
      /* already gone */
    }
  };
}

/** install.sh exactly as it is in this checkout, served the way raw.githubusercontent serves it. */
function serveInstaller() {
  const script = readFileSync(join(ROOT, 'install', 'install.sh'));
  const server = createServer((req, res) => {
    if (req.url !== '/install.sh') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' }).end(script);
  });
  server.listen(SCRIPT_PORT, '127.0.0.1');
  return () => server.close();
}

/**
 * Asynchronous on purpose. The installer is served from THIS process, and a synchronous spawn
 * blocks the event loop the server answers on: every container then failed to fetch the script, and
 * `curl | sh` turned that into an empty script that "succeeded" in a second.
 */
function dockerRun(args) {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += String(d)));
    child.stderr.on('data', (d) => (output += String(d)));
    const timer = setTimeout(() => child.kill('SIGKILL'), 15 * 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
  });
}

async function runSandbox(box) {
  const userCommand = `curl -fsSL http://${HOST}:${String(SCRIPT_PORT)}/install.sh | sh`;
  // The prep is the machine, not the install: a user who can paste a curl command has curl.
  const script = [
    box.prep === undefined ? ':' : `(${box.prep})`,
    `echo "\\$ ${userCommand}"`,
    `${userCommand}; rc=$?`,
    'echo "--- installer exit: $rc"',
    'if command -v reticle >/dev/null 2>&1; then echo "--- reticle --version: $(reticle --version 2>&1)"; fi',
    'exit $rc',
  ].join('\n');
  const started = Date.now();
  const { code, output } = await dockerRun([
    'run', '--rm',
    '-e', `npm_config_registry=http://${HOST}:${String(REGISTRY_PORT)}`,
    '-e', 'RETICLE_TELEMETRY=0',
    '-e', 'CI=',
    box.image, 'sh', '-c', script,
  ]);
  const seconds = Math.round((Date.now() - started) / 1000);
  const installed = 0 === code && /--- reticle --version: \d+\.\d+\.\d+/.test(output);
  const problems = [];
  // `curl | sh` exits 0 when curl fails, because sh ran an empty script. The banner is the proof
  // the installer itself ran at all.
  if (!/\[1\/4\]/.test(output.split('--- installer exit')[0] ?? '')) problems.push('the installer never ran');
  if ('installs' === box.expect && !installed) problems.push('did not install');
  if ('refuses' === box.expect && 0 === code) problems.push('installed where it must refuse');
  if (box.mustSay !== undefined && !box.mustSay.test(output)) problems.push(`never said ${String(box.mustSay)}`);
  if (box.demo !== undefined && !box.demo.test(output)) problems.push('the demo did not reach a verdict');
  return { box, code, seconds, output, problems };
}

async function main() {
  run('docker', ['info']);
  mkdirSync(OUT, { recursive: true });
  const stopRegistry = await startRegistry();
  const stopScript = serveInstaller();
  const results = [];
  try {
    for (const box of SANDBOXES.filter((each) => ONLY === undefined || each.name === ONLY)) {
      console.log(`\n=== ${box.name} (${box.image}) ===`);
      const result = await runSandbox(box);
      writeFileSync(join(OUT, `${box.name}.txt`), result.output);
      console.log(result.output.split('\n').slice(-12).join('\n'));
      results.push(result);
    }
  } finally {
    stopScript();
    stopRegistry();
  }
  const lines = results.map(
    (r) => `${0 === r.problems.length ? '✅' : '❌'} ${r.box.name.padEnd(16)} exit ${String(r.code).padEnd(3)} ${String(r.seconds).padStart(4)}s  ${0 === r.problems.length ? r.box.expect : r.problems.join('; ')}`,
  );
  writeFileSync(join(OUT, 'summary.txt'), `${lines.join('\n')}\n`);
  console.log(`\n${lines.join('\n')}\nsnapshots: ${OUT}`);
  if (results.some((r) => 0 < r.problems.length)) process.exit(1);
}

await main();
