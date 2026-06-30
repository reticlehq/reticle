import * as fs from 'node:fs';
import * as https from 'node:https';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { UpdateCheckIntervalMs } from '@reticlehq/protocol';
import { log } from '../log.js';

const RETICLE_HOME = join(homedir(), '.reticle');
const MANIFEST_PATH = join(RETICLE_HOME, 'update-manifest.json');
const NPM_REGISTRY = 'https://registry.npmjs.org/@reticlehq/core/latest';

interface UpdateManifest {
  currentVersion: string;
  latestVersion?: string;
  updateAvailable: boolean;
  lastChecked: string;
  changelog?: string;
  breakingChanges?: string[];
  /** The version that was running before the last update — used for rollback. */
  previousVersion?: string;
}

interface NpmPackageInfo {
  version: string;
  reticle?: {
    changelog?: string;
    breakingChanges?: string[];
  };
}

export function loadManifest(): UpdateManifest | null {
  if (!fs.existsSync(MANIFEST_PATH)) return null;
  try {
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
    return JSON.parse(raw) as UpdateManifest;
  } catch {
    return null;
  }
}

export function saveManifest(manifest: UpdateManifest): void {
  fs.mkdirSync(RETICLE_HOME, { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
}

function isCacheFresh(manifest: UpdateManifest, now: () => number): boolean {
  const checked = new Date(manifest.lastChecked).getTime();
  return now() - checked < UpdateCheckIntervalMs;
}

function fetchNpmInfo(): Promise<NpmPackageInfo> {
  return new Promise((resolve, reject) => {
    const req = https.get(NPM_REGISTRY, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body) as NpmPackageInfo);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      res.on('error', reject);
    });
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('npm registry request timed out'));
    });
    req.on('error', reject);
  });
}

/**
 * Returns the current update manifest, refreshing from the npm registry when the cache
 * is older than UpdateCheckIntervalMs. Never throws — falls back to the cached manifest
 * (or a safe "no update" default) when the registry is unreachable.
 */
export async function checkForUpdate(
  currentVersion: string,
  now: () => number,
): Promise<UpdateManifest> {
  const cached = loadManifest();
  if (cached !== null && cached.currentVersion === currentVersion && isCacheFresh(cached, now)) {
    return cached;
  }

  try {
    const info = await fetchNpmInfo();
    const updateAvailable = info.version !== currentVersion;
    const manifest: UpdateManifest = {
      currentVersion,
      latestVersion: info.version,
      updateAvailable,
      lastChecked: new Date(now()).toISOString(),
      ...(info.reticle?.changelog !== undefined ? { changelog: info.reticle.changelog } : {}),
      ...(info.reticle?.breakingChanges !== undefined
        ? { breakingChanges: info.reticle.breakingChanges }
        : {}),
      ...(cached?.previousVersion !== undefined ? { previousVersion: cached.previousVersion } : {}),
    };
    saveManifest(manifest);
    return manifest;
  } catch (err) {
    log('reticle_update_check_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    if (cached !== null) return { ...cached, currentVersion };
    return {
      currentVersion,
      updateAvailable: false,
      lastChecked: new Date(now()).toISOString(),
    };
  }
}
