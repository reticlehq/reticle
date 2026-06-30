import { join } from 'node:path';
import {
  CONTRACT_FILE_VERSION,
  ContractFileSchema,
  ContractReadError,
  FLOW_NAME_PATTERN,
  ReticleDir,
  type CapabilitiesContract,
  type ManifestGovernance,
  type RunId,
} from '@reticlehq/protocol';
import type { FileSystemPort } from './fs-port.js';

/** Resolved absolute paths inside a `.reticle/` root. Pure: join() only, no IO, no cwd. */
export interface ReticleDirPaths {
  /** .../.reticle */
  root: string;
  /** .../.reticle/contract.json */
  contract: string;
  /** .../.reticle/flows */
  flows: string;
  /** .../.reticle/baselines */
  baselines: string;
  /** .../.reticle/project.json (cross-run outcome memory) */
  project: string;
  /** .../.reticle/visual (PNG baselines + diffs) */
  visual: string;
  /** .../.reticle/runs (verification-run artifacts) */
  runs: string;
}

export function reticleDirPaths(root: string): ReticleDirPaths {
  return {
    root,
    contract: join(root, ReticleDir.CONTRACT_FILE),
    flows: join(root, ReticleDir.FLOWS_SUBDIR),
    baselines: join(root, ReticleDir.BASELINES_SUBDIR),
    project: join(root, ReticleDir.PROJECT_FILE),
    visual: join(root, ReticleDir.VISUAL_SUBDIR),
    runs: join(root, ReticleDir.RUNS_SUBDIR),
  };
}

/** The verification-run artifact path for `runId` (.reticle/runs/<runId>.json). */
export function runPath(root: string, runId: string): string {
  return join(root, ReticleDir.RUNS_SUBDIR, `${runId}.json`);
}

/**
 * A runId must be a single safe path segment — same guard as flow names (rejects '../', '/', '\\',
 * absolute, dotfiles). uuid-style ids (hyphens/underscores) pass. Guards every disk op before join.
 */
export function isValidRunId(runId: string): runId is RunId {
  return FLOW_NAME_PATTERN.test(runId) && !runId.includes('..');
}

/** The PNG baseline path for `name` (.reticle/visual/<name>.png). */
export function visualPath(root: string, name: string): string {
  return join(root, ReticleDir.VISUAL_SUBDIR, `${name}.png`);
}

/** The overlay-diff PNG path for `name` (.reticle/visual/<name>.diff.png). */
export function visualDiffPath(root: string, name: string): string {
  return join(root, ReticleDir.VISUAL_SUBDIR, `${name}.diff.png`);
}

export function flowPath(root: string, name: string): string {
  return join(root, ReticleDir.FLOWS_SUBDIR, `${name}.json`);
}

/**
 * A flow name must be a single safe path segment — rejects '../', '/', '\\', absolute, dotfiles.
 * Guards every disk op before a path is ever joined, so a traversal name never escapes .reticle/.
 */
export function isValidFlowName(name: string): boolean {
  return FLOW_NAME_PATTERN.test(name) && !name.includes('..');
}

export function baselinePath(root: string, name: string): string {
  return join(root, ReticleDir.BASELINES_SUBDIR, `${name}.json`);
}

/** Idempotent: creates .reticle/, .reticle/flows/, .reticle/baselines/ (recursive mkdir → safe to re-run). */
export async function ensureReticleDir(fs: FileSystemPort, root: string): Promise<void> {
  const p = reticleDirPaths(root);
  await fs.mkdir(p.root);
  await fs.mkdir(p.flows);
  await fs.mkdir(p.baselines);
}

const JSON_INDENT = 2;

/**
 * Serialize capabilities into a byte-stable, diffable string: arrays sorted lexicographically,
 * flows sorted by name, object keys emitted in a fixed declared order (NOT insertion order),
 * 2-space indent, trailing newline. Two semantically-equal registries → identical bytes.
 */
function stableSerialize(capabilities: CapabilitiesContract, generatedAt: number): string {
  const envelope = {
    version: CONTRACT_FILE_VERSION,
    generatedAt,
    capabilities: {
      testids: [...capabilities.testids].sort(),
      signals: [...capabilities.signals].sort(),
      stores: [...capabilities.stores].sort(),
      flows: [...capabilities.flows]
        .map((f) => ({ name: f.name, steps: [...f.steps] }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      ...(capabilities.governance !== undefined
        ? { governance: serializeGovernance(capabilities.governance) }
        : {}),
    },
  };
  return `${JSON.stringify(envelope, null, JSON_INDENT)}\n`;
}

/** Field-ordered, sorted rebuild of declared governance for byte-stable serialization. */
function serializeGovernance(g: ManifestGovernance): ManifestGovernance {
  return {
    ...(g.owner !== undefined ? { owner: g.owner } : {}),
    ...(g.safety !== undefined ? { safety: [...g.safety].sort() } : {}),
    ...(g.scope !== undefined ? { scope: [...g.scope].sort() } : {}),
    ...(g.redact !== undefined ? { redact: [...g.redact].sort() } : {}),
    ...(g.risk !== undefined
      ? {
          risk: [...g.risk]
            .map((z) => ({
              surface: z.surface,
              ...(z.paths !== undefined ? { paths: [...z.paths].sort() } : {}),
              ...(z.note !== undefined ? { note: z.note } : {}),
            }))
            .sort((a, b) => (a.surface < b.surface ? -1 : a.surface > b.surface ? 1 : 0)),
        }
      : {}),
  };
}

/** Write the contract to .reticle/contract.json (auto-creating .reticle/ first). */
export async function writeContract(
  fs: FileSystemPort,
  root: string,
  capabilities: CapabilitiesContract,
  now: () => number,
): Promise<void> {
  await ensureReticleDir(fs, root);
  await fs.writeFile(reticleDirPaths(root).contract, stableSerialize(capabilities, now()));
}

export type ReadContractResult =
  | { ok: true; capabilities: CapabilitiesContract; generatedAt: number }
  | { ok: false; reason: ContractReadError };

/** Never throws. Missing → MISSING. Bad JSON / failed schema → MALFORMED. */
export async function readContract(fs: FileSystemPort, root: string): Promise<ReadContractResult> {
  const path = reticleDirPaths(root).contract;
  if (!(await fs.exists(path))) return { ok: false, reason: ContractReadError.MISSING };

  let text: string;
  try {
    text = await fs.readFile(path);
  } catch (error) {
    // Handles the exists/read TOCTOU race: a vanished file reads as MISSING, anything else MALFORMED.
    return {
      ok: false,
      reason: fs.isNotFound(error) ? ContractReadError.MISSING : ContractReadError.MALFORMED,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: ContractReadError.MALFORMED };
  }

  const result = ContractFileSchema.safeParse(parsed);
  if (!result.success) return { ok: false, reason: ContractReadError.MALFORMED };
  return { ok: true, capabilities: result.data.capabilities, generatedAt: result.data.generatedAt };
}
