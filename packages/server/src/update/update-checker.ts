import * as fs from 'node:fs';
import * as https from 'node:https';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { UpdateCheckIntervalMs } from '@reticlehq/core';
import { RETICLE_NPM_PACKAGE } from '../version/server-version.js';
import { log } from '../log.js';

const RETICLE_HOME = join(homedir(), '.reticle');
const MANIFEST_PATH = join(RETICLE_HOME, 'update-manifest.json');
// Poll the package that carries the bin (@reticlehq/server), so the version we compare against and
// the version we install are the same package — not @reticlehq/core, which only tracks it by luck.
const NPM_REGISTRY = `https://registry.npmjs.org/${RETICLE_NPM_PACKAGE}/latest`;

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

// npm's registry is trusted, but this response is persisted to disk AND echoed into the agent's
// context, so validate its shape before it flows anywhere: a plausible semver, bounded free-text.
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const MAX_MANIFEST_TEXT = 20_000;

/** Reject an implausible version (throws → caller falls back to cache) and bound the free-text
 * fields, so a malformed or oversized registry response can neither corrupt nor bloat the manifest. */
function validateNpmInfo(info: NpmPackageInfo): NpmPackageInfo {
  if (typeof info.version !== 'string' || !VERSION_RE.test(info.version)) {
    throw new Error('npm registry returned an implausible version');
  }
  const changelog =
    'string' === typeof info.reticle?.changelog
      ? info.reticle.changelog.slice(0, MAX_MANIFEST_TEXT)
      : undefined;
  const breakingChanges = Array.isArray(info.reticle?.breakingChanges)
    ? info.reticle.breakingChanges
        .filter((x): x is string => 'string' === typeof x)
        .slice(0, 100)
        .map((s) => s.slice(0, MAX_MANIFEST_TEXT))
    : undefined;
  const reticle: NpmPackageInfo['reticle'] = {
    ...(changelog !== undefined ? { changelog } : {}),
    ...(breakingChanges !== undefined ? { breakingChanges } : {}),
  };
  return { version: info.version, reticle };
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

/** Injectable IO for checkForUpdate so the network + manifest cache are testable (default = real). */
export interface UpdateCheckPorts {
  fetchInfo: () => Promise<NpmPackageInfo>;
  loadManifest: () => UpdateManifest | null;
  saveManifest: (manifest: UpdateManifest) => void;
}

const defaultPorts: UpdateCheckPorts = { fetchInfo: fetchNpmInfo, loadManifest, saveManifest };

/**
 * Returns the current update manifest, refreshing from the npm registry when the cache
 * is older than UpdateCheckIntervalMs. Never throws — falls back to the cached manifest
 * (or a safe "no update" default) when the registry is unreachable.
 */
export async function checkForUpdate(
  currentVersion: string,
  now: () => number,
  ports: UpdateCheckPorts = defaultPorts,
): Promise<UpdateManifest> {
  const cached = ports.loadManifest();
  if (cached !== null && cached.currentVersion === currentVersion && isCacheFresh(cached, now)) {
    return cached;
  }

  try {
    const info = validateNpmInfo(await ports.fetchInfo());
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
    ports.saveManifest(manifest);
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
