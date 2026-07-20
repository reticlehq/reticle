import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProjectCloud, CLOUD_LINK_FILE, CREDENTIALS_FILE } from './cloud-config.js';
import { createNodeFileSystem, type FileSystemPort } from '../project/fs-port.js';

describe('resolveProjectCloud — per-project cloud binding + sync policy', () => {
  let dir: string;
  let reticleRoot: string; // <dir>/proj/.reticle
  let homeDir: string; // <dir>/home  (holds .reticle/credentials.json)
  let fs: FileSystemPort;
  const env: NodeJS.ProcessEnv = {};

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reticle-cloudcfg-'));
    reticleRoot = join(dir, 'proj', '.reticle');
    homeDir = join(dir, 'home');
    await mkdir(reticleRoot, { recursive: true });
    fs = createNodeFileSystem();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const writeLink = (obj: unknown): Promise<void> =>
    writeFile(join(reticleRoot, CLOUD_LINK_FILE), JSON.stringify(obj));
  const writeCreds = async (obj: unknown): Promise<void> => {
    await mkdir(join(homeDir, '.reticle'), { recursive: true });
    await writeFile(join(homeDir, '.reticle', CREDENTIALS_FILE), JSON.stringify(obj));
  };

  it('falls back to env creds when the project has no cloud.json (single-project / CI)', async () => {
    const withEnv = { RETICLE_CLOUD_URL: 'https://cloud.test', RETICLE_CLOUD_KEY: 'rk_live_env' };
    const cloud = await resolveProjectCloud(fs, reticleRoot, homeDir, withEnv);
    expect(cloud.config).toEqual({ url: 'https://cloud.test', apiKey: 'rk_live_env' });
    expect(cloud.policy).toEqual({ runs: true, memory: true, flows: true });
    expect(cloud.projectId).toBeNull();
  });

  it('resolves url from cloud.json + key from the user keystore (secret stays out of the repo)', async () => {
    await writeLink({ projectId: 'shop', url: 'https://cloud.test/' });
    await writeCreds({ shop: 'rk_live_shopkey', blog: 'rk_live_other' });
    const cloud = await resolveProjectCloud(fs, reticleRoot, homeDir, env);
    expect(cloud.config).toEqual({ url: 'https://cloud.test', apiKey: 'rk_live_shopkey' });
    expect(cloud.projectId).toBe('shop');
  });

  it('reports cloud NOT attached when linked but no credential exists for the project', async () => {
    await writeLink({ projectId: 'shop', url: 'https://cloud.test' });
    await writeCreds({ blog: 'rk_live_other' }); // no key for 'shop'
    const cloud = await resolveProjectCloud(fs, reticleRoot, homeDir, env);
    expect(cloud.config).toBeNull();
    expect(cloud.projectId).toBe('shop'); // still know which project it WANTS to attach to
  });

  it('honors a per-project sync policy (e.g. push flows only, not runs/memory)', async () => {
    await writeLink({
      projectId: 'shop',
      url: 'https://cloud.test',
      sync: { runs: false, memory: false, flows: true },
    });
    await writeCreds({ shop: 'rk_live_shopkey' });
    const cloud = await resolveProjectCloud(fs, reticleRoot, homeDir, env);
    expect(cloud.policy).toEqual({ runs: false, memory: false, flows: true });
    expect(cloud.config).not.toBeNull();
  });

  it('parses verify:server and defaults verify to local otherwise', async () => {
    await writeLink({ projectId: 'shop', url: 'https://cloud.test', verify: 'server' });
    await writeCreds({ shop: 'rk_live_shopkey' });
    expect((await resolveProjectCloud(fs, reticleRoot, homeDir, env)).verify).toBe('server');

    await writeLink({ projectId: 'shop', url: 'https://cloud.test' });
    expect((await resolveProjectCloud(fs, reticleRoot, homeDir, env)).verify).toBe('local');
  });

  it('a malformed cloud.json degrades to the env fallback (never throws)', async () => {
    await writeFile(join(reticleRoot, CLOUD_LINK_FILE), '{ not valid json');
    const withEnv = { RETICLE_CLOUD_URL: 'https://cloud.test', RETICLE_CLOUD_KEY: 'rk_live_env' };
    const cloud = await resolveProjectCloud(fs, reticleRoot, homeDir, withEnv);
    expect(cloud.config).toEqual({ url: 'https://cloud.test', apiKey: 'rk_live_env' });
  });

  it('is fully local when neither a link nor env creds exist (no phone-home)', async () => {
    const cloud = await resolveProjectCloud(fs, reticleRoot, homeDir, {});
    expect(cloud.config).toBeNull();
  });
});
