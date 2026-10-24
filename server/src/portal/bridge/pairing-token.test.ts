import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { resolveBridgeSecurityWithAutoToken } from './bridge-security.js';
import { ReticleEnv } from '@reticlehq/core';
import {
  configuredPairingToken,
  defaultPairingTokenDir,
  pairingTokenPath,
  readOrCreatePairingToken,
  readOrCreatePairingTokenSync,
  type PairingTokenDeps,
} from './pairing-token.js';

/** In-memory IO adapter so the provisioner never touches the real ~/.reticle. */
function memDeps(
  seed: Record<string, string> = {},
  randomToken = (): string => 'generated-token',
): { deps: PairingTokenDeps; files: Map<string, string>; writes: () => number } {
  const files = new Map(Object.entries(seed));
  let writes = 0;
  const deps: PairingTokenDeps = {
    readFile: (path) => {
      const v = files.get(path);
      if (v === undefined) {
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      }
      return Promise.resolve(v);
    },
    writeFile: (path, data) => {
      writes += 1;
      files.set(path, data);
      return Promise.resolve();
    },
    mkdir: () => Promise.resolve(),
    randomToken,
  };
  return { deps, files, writes: () => writes };
}

const DIR = '/home/u/.reticle';

describe('readOrCreatePairingToken', () => {
  it('creates and persists a token on first run', async () => {
    const { deps, files } = memDeps();
    const token = await readOrCreatePairingToken(DIR, deps);
    expect(token).toBe('generated-token');
    expect(files.get(pairingTokenPath(DIR))).toBe('generated-token');
  });

  it('returns the existing token on subsequent runs (stable, no rewrite)', async () => {
    const ctx = memDeps({ [pairingTokenPath(DIR)]: 'existing-secret\n' });
    const token = await readOrCreatePairingToken(DIR, ctx.deps);
    expect(token).toBe('existing-secret');
    expect(ctx.writes()).toBe(0);
  });

  it('regenerates when the stored token is blank', async () => {
    const { deps } = memDeps({ [pairingTokenPath(DIR)]: '   ' });
    expect(await readOrCreatePairingToken(DIR, deps)).toBe('generated-token');
  });

  it('degrades to undefined (not a throw) when writing fails', async () => {
    const { deps } = memDeps();
    deps.writeFile = () => Promise.reject(new Error('EACCES'));
    expect(await readOrCreatePairingToken(DIR, deps)).toBeUndefined();
  });

  it('returns undefined rather than an empty token when randomness yields nothing', async () => {
    const { deps } = memDeps({}, () => '');
    expect(await readOrCreatePairingToken(DIR, deps)).toBeUndefined();
  });
});

describe('readOrCreatePairingTokenSync — the same mint, for init and Next', () => {
  it('creates a token when the file is missing, and reuses it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-pairing-sync-'));
    const first = readOrCreatePairingTokenSync(dir);
    expect(typeof first).toBe('string');
    expect((first ?? '').length).toBeGreaterThan(0);
    expect(readOrCreatePairingTokenSync(dir)).toBe(first);
  });

  it('honours RETICLE_PAIRING_TOKEN_DIR rather than always reading $HOME', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-pairing-override-'));
    writeFileSync(join(dir, 'pairing-token'), 'from-override\n');
    const prev = process.env[ReticleEnv.PAIRING_TOKEN_DIR];
    process.env[ReticleEnv.PAIRING_TOKEN_DIR] = dir;
    try {
      expect(readOrCreatePairingTokenSync(defaultPairingTokenDir())).toBe('from-override');
    } finally {
      if (prev === undefined) delete process.env[ReticleEnv.PAIRING_TOKEN_DIR];
      else process.env[ReticleEnv.PAIRING_TOKEN_DIR] = prev;
    }
  });
});

// #1251: in a container the app bakes the directory token in, and `verify` minted its own.
describe('configuredPairingToken', () => {
  it('is RETICLE_TOKEN, else the token in RETICLE_PAIRING_TOKEN_DIR, else nothing', async () => {
    const { deps } = memDeps({ [pairingTokenPath('/mnt/tok')]: 'dir-token' });
    expect(await configuredPairingToken({ [ReticleEnv.TOKEN]: 'env-token' }, deps)).toBe(
      'env-token',
    );
    expect(await configuredPairingToken({ [ReticleEnv.PAIRING_TOKEN_DIR]: '/mnt/tok' }, deps)).toBe(
      'dir-token',
    );
    expect(await configuredPairingToken({}, deps)).toBeUndefined();
  });
});

/**
 * Up to 3.7 a relative token folder was used against the working folder (CI, docker compose). A
 * rule that threw on it stopped the daemon at start, so the agent had no daemon at all.
 */
describe('a pairing token folder that is not absolute', () => {
  function withTokenDir(value: string, body: () => unknown): () => Promise<void> {
    return async () => {
      const saved = process.env[ReticleEnv.PAIRING_TOKEN_DIR];
      const cwd = mkdtempSync(join(tmpdir(), 'reticle-relative-token-'));
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
      const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      process.env[ReticleEnv.PAIRING_TOKEN_DIR] = value;
      try {
        await body();
      } finally {
        cwdSpy.mockRestore();
        stderr.mockRestore();
        if (saved === undefined) {
          delete process.env[ReticleEnv.PAIRING_TOKEN_DIR];
        } else {
          process.env[ReticleEnv.PAIRING_TOKEN_DIR] = saved;
        }
      }
    };
  }

  it(
    'does not stop the daemon: the token is made in the working folder',
    withTokenDir('relative/.reticle', async () => {
      const security = await resolveBridgeSecurityWithAutoToken({});
      const file = join(process.cwd(), 'relative', '.reticle', 'pairing-token');
      expect(security.token).toBe(readFileSync(file, 'utf8'));
      expect(readOrCreatePairingTokenSync(defaultPairingTokenDir())).toBe(security.token);
    }),
  );

  it(
    'uses the home folder for a Windows path on POSIX, and makes no folder in the working folder',
    withTokenDir('C:\\Users\\u\\.reticle', () => {
      if ('/' !== sep) {
        return;
      }
      expect(defaultPairingTokenDir()).toBe(join(homedir(), '.reticle'));
      expect(readdirSync(process.cwd())).toEqual([]);
    }),
  );
});
