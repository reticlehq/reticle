import { describe, expect, it } from 'vitest';
import {
  bootstrapPlan,
  bucketAlreadyExists,
  deploymentNotReady,
  parseBootstrapArgs,
  reticleCommand,
  selectBootstrapKey,
  workerUrlFromOutput,
} from './bootstrap-lib.mjs';

describe('Cloudflare bootstrap CLI', () => {
  it('plans the complete automatic setup by default', () => {
    const options = parseBootstrapArgs([]);
    expect(options.parallel).toBe(4);
    expect(bootstrapPlan(options)).toEqual([
      'check Cloudflare authentication and Browser Run access',
      'create R2 bucket reticle-cloudflare-artifacts when missing',
      'deploy Worker reticle-cloudflare',
      'reuse or generate and configure RETICLE_CLOUD_KEY',
      'link this repository and enable verify:server',
      'upload all existing flows and runs',
      'run a live Cloudflare browser smoke verification',
    ]);
  });

  it('validates bounded remote parallelism and an explicit Worker name', () => {
    expect(
      parseBootstrapArgs(['init', '--worker', 'reticle-shop', '--parallel', '8', '--dry-run']),
    ).toMatchObject({
      worker: 'reticle-shop',
      bucket: 'reticle-cloudflare-artifacts',
      parallel: 8,
      dryRun: true,
    });
    expect(parseBootstrapArgs(['init', '--rotate-key']).rotateKey).toBe(true);
    expect(() => parseBootstrapArgs(['init', '--parallel', '0'])).toThrow(/1 to 10/);
    expect(() => parseBootstrapArgs(['destroy'])).toThrow(/unknown command/);
  });

  it('extracts the deployed workers.dev URL and recognizes idempotent bucket creation', () => {
    expect(workerUrlFromOutput('Deployed\n https://reticle-shop.acct.workers.dev\n')).toBe(
      'https://reticle-shop.acct.workers.dev',
    );
    expect(bucketAlreadyExists('The specified bucket already exists. [code: 10004]')).toBe(true);
    expect(deploymentNotReady('reticle: 401 Unauthorized')).toBe(true);
  });

  it('runs the matching published Reticle CLI without an edge-to-node dependency', () => {
    expect(reticleCommand('2.9.0', ['push'], 'linux')).toEqual({
      command: 'npx',
      args: ['--yes', '--package', '@reticlehq/server@2.9.0', '--', 'reticle', 'push'],
    });
    expect(reticleCommand('2.9.0', ['link'], 'win32').command).toBe('npx.cmd');
  });

  it('keeps an existing credential unless rotation is explicit', () => {
    const generate = () => 'generated';
    expect(selectBootstrapKey('from-env', 'cached', false, generate)).toBe('from-env');
    expect(selectBootstrapKey(undefined, 'cached', false, generate)).toBe('cached');
    expect(selectBootstrapKey('from-env', 'cached', true, generate)).toBe('generated');
  });
});
