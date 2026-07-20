/**
 * Per-project cloud resolution for a SHARED daemon. One reticle MCP/daemon serves many projects; each
 * project declares its own cloud binding + sync policy in `<root>/.reticle/cloud.json`, and the SECRET
 * (the API key) lives once per user in `~/.reticle/credentials.json` (keyed by cloud project id) — never
 * in the repo. The daemon resolves "is cloud attached for THIS project, and what should I push where?"
 * from those two files, falling back to the global `RETICLE_CLOUD_*` env vars for the single-project /
 * CI case (backward compatible).
 *
 * Vercel-style split: `.reticle/cloud.json` is the safe-to-commit-but-gitignored binding, the key is a
 * user-level credential. "Cloud attached" = a valid link file AND a key for its project id (or env creds).
 */
import { join } from 'node:path';
import { ReticleDir } from '@reticlehq/core';
import type { FileSystemPort } from '../project/fs-port.js';
import { resolveCloudConfig, type CloudConfig } from './cloud-sync.js';

/** `<reticleRoot>/cloud.json` — the project's cloud binding + sync policy (non-secret). */
export const CLOUD_LINK_FILE = 'cloud.json';
/** `~/.reticle/credentials.json` — the user's per-cloud-project API keys (the only secret). */
export const CREDENTIALS_FILE = 'credentials.json';

/** What the daemon mirrors to the cloud for a project. Each surface is independently toggleable. */
export interface SyncPolicy {
  /** Push verification-run artifacts to the dashboard Runs tab. */
  runs: boolean;
  /** Push per-flow project-memory outcomes (the regression history). */
  memory: boolean;
  /** Sync saved flow files (the shared regression suite). */
  flows: boolean;
}
export const DEFAULT_SYNC_POLICY: SyncPolicy = { runs: true, memory: true, flows: true };

/** Where a verification actually executes. Reserved for the hosted-runner path; default local. */
export const VerifyMode = { LOCAL: 'local', SERVER: 'server' } as const;
export type VerifyMode = (typeof VerifyMode)[keyof typeof VerifyMode];

/** The resolved cloud picture for one project. `config === null` ⇒ cloud NOT attached (stay 100% local). */
export interface ProjectCloud {
  config: CloudConfig | null;
  policy: SyncPolicy;
  verify: VerifyMode;
  /** The cloud project id this project is linked to (for display/logging); null when env-fallback. */
  projectId: string | null;
}

interface CloudLink {
  projectId: string;
  url: string;
  sync: Partial<SyncPolicy>;
  verify: VerifyMode;
}

const asBool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

/** Read + JSON-parse a file, or null on any problem (missing/malformed) — never throws. */
async function readJson(fs: FileSystemPort, path: string): Promise<unknown> {
  try {
    if (!(await fs.exists(path))) return null;
    return JSON.parse(await fs.readFile(path));
  } catch {
    return null;
  }
}

/** Validate the shape of `.reticle/cloud.json`. Requires projectId + url; policy/verify default in. */
function parseLink(raw: unknown): CloudLink | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.projectId !== 'string' || o.projectId.length === 0) return null;
  if (typeof o.url !== 'string' || o.url.length === 0) return null;
  const sync =
    typeof o.sync === 'object' && o.sync !== null ? (o.sync as Record<string, unknown>) : {};
  return {
    projectId: o.projectId,
    url: o.url,
    sync: {
      runs: asBool(sync.runs, DEFAULT_SYNC_POLICY.runs),
      memory: asBool(sync.memory, DEFAULT_SYNC_POLICY.memory),
      flows: asBool(sync.flows, DEFAULT_SYNC_POLICY.flows),
    },
    verify: o.verify === VerifyMode.SERVER ? VerifyMode.SERVER : VerifyMode.LOCAL,
  };
}

/** Look up the API key for a cloud project id in the user credentials map. */
function credentialFor(raw: unknown, projectId: string): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const key = (raw as Record<string, unknown>)[projectId];
  return typeof key === 'string' && key.length > 0 ? key : null;
}

/**
 * Resolve the cloud picture for a project rooted at `reticleRoot`. Reads the project's link file + the
 * user credential store; if the project isn't linked (no cloud.json), falls back to the global env creds
 * so the single-project / CI flow is unchanged. `homeDir` is injected (testable; `os.homedir()` at call).
 */
export async function resolveProjectCloud(
  fs: FileSystemPort,
  reticleRoot: string,
  homeDir: string,
  env: NodeJS.ProcessEnv,
): Promise<ProjectCloud> {
  const link = parseLink(await readJson(fs, join(reticleRoot, CLOUD_LINK_FILE)));
  if (link === null) {
    // No per-project link → the env vars are the whole story (legacy single-project / CI behaviour).
    return {
      config: resolveCloudConfig(env),
      policy: DEFAULT_SYNC_POLICY,
      verify: VerifyMode.LOCAL,
      projectId: null,
    };
  }
  const policy: SyncPolicy = {
    runs: link.sync.runs ?? DEFAULT_SYNC_POLICY.runs,
    memory: link.sync.memory ?? DEFAULT_SYNC_POLICY.memory,
    flows: link.sync.flows ?? DEFAULT_SYNC_POLICY.flows,
  };
  const key = credentialFor(
    await readJson(fs, join(homeDir, ReticleDir.ROOT, CREDENTIALS_FILE)),
    link.projectId,
  );
  const config: CloudConfig | null =
    key !== null ? { url: link.url.replace(/\/+$/, ''), apiKey: key } : null;
  return { config, policy, verify: link.verify, projectId: link.projectId };
}
