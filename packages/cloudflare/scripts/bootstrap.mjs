#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  bootstrapPlan,
  bucketAlreadyExists,
  deploymentNotReady,
  parseBootstrapArgs,
  reticleCommand,
  selectBootstrapKey,
  workerUrlFromOutput,
} from './bootstrap-lib.mjs';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const wranglerPackage = require.resolve('wrangler/package.json');
const wranglerBin = join(dirname(wranglerPackage), 'bin', 'wrangler.js');
const packageVersion = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
const credentialPath = join(homedir(), '.reticle', 'cloudflare-workers.json');

function credentialCache() {
  try {
    if (!existsSync(credentialPath)) return {};
    const parsed = JSON.parse(readFileSync(credentialPath, 'utf8'));
    if ('object' !== typeof parsed || null === parsed) return {};
    return parsed;
  } catch {
    return {};
  }
}

function cachedKey(url) {
  const value = credentialCache()[url];
  return 'string' === typeof value && value.length > 0 ? value : undefined;
}

function rememberKey(url, key) {
  mkdirSync(dirname(credentialPath), { recursive: true, mode: 0o700 });
  writeFileSync(
    credentialPath,
    `${JSON.stringify({ ...credentialCache(), [url]: key }, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  chmodSync(credentialPath, 0o600);
}

function run(command, args, { cwd = process.cwd(), env = process.env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (chunk) => {
      const text = String(chunk);
      output += text;
      process.stderr.write(text);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function requireSuccess(label, command, args, options) {
  process.stderr.write(`\n[reticle-cloudflare] ${label}\n`);
  const result = await run(command, args, options);
  if (0 !== result.code) throw new Error(`${label} failed (exit ${String(result.code)})`);
  return result.output;
}

async function requireReady(label, command, args, options) {
  const attempts = 10;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    process.stderr.write(`\n[reticle-cloudflare] ${label} (attempt ${String(attempt)})\n`);
    const result = await run(command, args, options);
    if (0 === result.code) return result.output;
    if (!deploymentNotReady(result.output) || attempt === attempts) {
      throw new Error(`${label} failed (exit ${String(result.code)})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`${label} failed`);
}

async function main() {
  const options = parseBootstrapArgs(process.argv.slice(2));
  const plan = bootstrapPlan(options);
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({ dryRun: true, plan, options }, null, 2)}\n`);
    return;
  }

  await requireSuccess(
    'checking Cloudflare authentication',
    process.execPath,
    [wranglerBin, 'whoami'],
    {
      cwd: packageRoot,
    },
  );
  process.stderr.write(`\n[reticle-cloudflare] creating R2 bucket ${options.bucket}\n`);
  const bucket = await run(
    process.execPath,
    [wranglerBin, 'r2', 'bucket', 'create', options.bucket],
    {
      cwd: packageRoot,
    },
  );
  if (0 !== bucket.code && !bucketAlreadyExists(bucket.output)) {
    throw new Error(`R2 bucket creation failed (exit ${String(bucket.code)})`);
  }

  const deployed = await requireSuccess(
    `deploying ${options.worker}`,
    process.execPath,
    [
      wranglerBin,
      'deploy',
      '--name',
      options.worker,
      '--var',
      `RETICLE_DEFAULT_PARALLEL:${String(options.parallel)}`,
    ],
    { cwd: packageRoot },
  );
  const url = workerUrlFromOutput(deployed);
  if (url === undefined)
    throw new Error('Wrangler deployed the Worker but returned no workers.dev URL');

  const key = selectBootstrapKey(
    process.env.RETICLE_CLOUD_KEY,
    cachedKey(url),
    options.rotateKey,
    () => randomBytes(32).toString('hex'),
  );
  await requireSuccess(
    'configuring the Worker secret',
    process.execPath,
    [wranglerBin, 'secret', 'put', 'RETICLE_CLOUD_KEY', '--name', options.worker],
    { cwd: packageRoot, input: key },
  );
  rememberKey(url, key);
  const linkedEnv = { ...process.env, RETICLE_CLOUD_URL: url, RETICLE_CLOUD_KEY: key };
  const reticle = (args) => reticleCommand(packageVersion, args);
  const link = reticle(['link']);
  await requireReady('linking the current Reticle project', link.command, link.args, {
    env: linkedEnv,
  });
  const config = reticle(['config', '--verify', 'server']);
  await requireSuccess('enabling server verification', config.command, config.args, {
    env: linkedEnv,
  });
  const push = reticle(['push']);
  await requireSuccess('uploading existing flows and runs', push.command, push.args, {
    env: linkedEnv,
  });
  if (!options.skipSmoke) {
    await requireSuccess(
      'running the live browser smoke',
      process.execPath,
      [join(packageRoot, 'scripts', 'smoke.mjs')],
      {
        cwd: packageRoot,
        env: { ...linkedEnv, RETICLE_CLOUDFLARE_URL: url },
      },
    );
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        ready: true,
        url,
        worker: options.worker,
        bucket: options.bucket,
        parallel: options.parallel,
        linked: process.cwd(),
        flowsAndRunsUploaded: true,
        smoke: options.skipSmoke ? 'skipped' : 'pass',
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `[reticle-cloudflare] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
