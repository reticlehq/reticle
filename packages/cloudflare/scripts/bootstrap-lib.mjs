export const DEFAULT_WORKER = 'reticle-cloudflare';
export const DEFAULT_BUCKET = 'reticle-cloudflare-artifacts';

export function parseBootstrapArgs(argv) {
  const args = [...argv];
  const command = args[0]?.startsWith('-') ? 'init' : (args.shift() ?? 'init');
  const options = {
    command,
    worker: DEFAULT_WORKER,
    bucket: DEFAULT_BUCKET,
    parallel: 4,
    dryRun: false,
    skipSmoke: false,
    rotateKey: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if ('--dry-run' === arg) options.dryRun = true;
    else if ('--skip-smoke' === arg) options.skipSmoke = true;
    else if ('--rotate-key' === arg) options.rotateKey = true;
    else if ('--worker' === arg || '--parallel' === arg) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('-')) throw new Error(`${arg} requires a value`);
      index += 1;
      if ('--worker' === arg) options.worker = value;
      else options.parallel = Number(value);
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if ('init' !== options.command) throw new Error(`unknown command ${options.command}`);
  if (!Number.isInteger(options.parallel) || options.parallel < 1 || options.parallel > 10) {
    throw new Error('--parallel must be an integer from 1 to 10');
  }
  return options;
}

export function bootstrapPlan(options) {
  return [
    'check Cloudflare authentication and Browser Run access',
    `create R2 bucket ${options.bucket} when missing`,
    `deploy Worker ${options.worker}`,
    options.rotateKey
      ? 'rotate and configure RETICLE_CLOUD_KEY'
      : 'reuse or generate and configure RETICLE_CLOUD_KEY',
    'link this repository and enable verify:server',
    'upload all existing flows and runs',
    ...(options.skipSmoke ? [] : ['run a live Cloudflare browser smoke verification']),
  ];
}

export function workerUrlFromOutput(output) {
  return output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0];
}

export function bucketAlreadyExists(output) {
  return /already exists|code\s*10004/i.test(output);
}

export function deploymentNotReady(output) {
  return /401|unauthorized/i.test(output);
}

export function reticleCommand(version, args, platform = process.platform) {
  return {
    command: 'win32' === platform ? 'npx.cmd' : 'npx',
    args: ['--yes', '--package', `@reticlehq/server@${version}`, '--', 'reticle', ...args],
  };
}

export function selectBootstrapKey(environmentKey, cachedKey, rotateKey, generate) {
  if (!rotateKey && 'string' === typeof environmentKey && environmentKey.length > 0) {
    return environmentKey;
  }
  if (!rotateKey && 'string' === typeof cachedKey && cachedKey.length > 0) return cachedKey;
  return generate();
}
