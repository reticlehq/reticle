import { join } from 'node:path';
import {
  CONTRACT_FILE_VERSION,
  ContractFileSchema,
  ContractReadError,
  FLOW_NAME_PATTERN,
  IrisDir,
  type CapabilitiesContract,
} from '@syrin/iris-protocol';
import type { FileSystemPort } from './fs-port.js';

/** Resolved absolute paths inside a `.iris/` root. Pure: join() only, no IO, no cwd. */
export interface IrisDirPaths {
  /** .../.iris */
  root: string;
  /** .../.iris/contract.json */
  contract: string;
  /** .../.iris/flows */
  flows: string;
  /** .../.iris/baselines */
  baselines: string;
  /** .../.iris/project.json (0.3.7 RUNHISTORY: cross-run outcome memory) */
  project: string;
}

export function irisDirPaths(root: string): IrisDirPaths {
  return {
    root,
    contract: join(root, IrisDir.CONTRACT_FILE),
    flows: join(root, IrisDir.FLOWS_SUBDIR),
    baselines: join(root, IrisDir.BASELINES_SUBDIR),
    project: join(root, IrisDir.PROJECT_FILE),
  };
}

export function flowPath(root: string, name: string): string {
  return join(root, IrisDir.FLOWS_SUBDIR, `${name}.json`);
}

/**
 * A flow name must be a single safe path segment — rejects '../', '/', '\\', absolute, dotfiles.
 * Guards every disk op before a path is ever joined, so a traversal name never escapes .iris/.
 */
export function isValidFlowName(name: string): boolean {
  return FLOW_NAME_PATTERN.test(name) && !name.includes('..');
}

export function baselinePath(root: string, name: string): string {
  return join(root, IrisDir.BASELINES_SUBDIR, `${name}.json`);
}

/** Idempotent: creates .iris/, .iris/flows/, .iris/baselines/ (recursive mkdir → safe to re-run). */
export async function ensureIrisDir(fs: FileSystemPort, root: string): Promise<void> {
  const p = irisDirPaths(root);
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
    },
  };
  return `${JSON.stringify(envelope, null, JSON_INDENT)}\n`;
}

/** Write the contract to .iris/contract.json (auto-creating .iris/ first). */
export async function writeContract(
  fs: FileSystemPort,
  root: string,
  capabilities: CapabilitiesContract,
  now: () => number,
): Promise<void> {
  await ensureIrisDir(fs, root);
  await fs.writeFile(irisDirPaths(root).contract, stableSerialize(capabilities, now()));
}

export type ReadContractResult =
  | { ok: true; capabilities: CapabilitiesContract; generatedAt: number }
  | { ok: false; reason: ContractReadError };

/** Never throws. Missing → MISSING. Bad JSON / failed schema → MALFORMED. */
export async function readContract(fs: FileSystemPort, root: string): Promise<ReadContractResult> {
  const path = irisDirPaths(root).contract;
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
