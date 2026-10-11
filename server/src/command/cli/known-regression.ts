/**
 * The flows the linked project's platform says passed before and are broken now — what
 * `reticle runs regression` prints, read here so `reticle gate` can fail on it too.
 *
 * Its own module, not a call into `cloud-cli.ts`: the gate is on the library's import path, and the
 * cloud CLI reaches the install-time surface the library must never load.
 */
import { homedir } from 'node:os';
import { z } from 'zod';
import { resolveProjectCloud } from '@/memory/cloud/cloud-config.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { CredentialRefusedError, api } from './cloud-kit.js';

const REGRESSION_PATH = '/v1/project/regression';

/** The `broken` list of a regression report, or undefined when the report has none. */
export function brokenOf(report: unknown): unknown[] | undefined {
  const parsed = z.object({ broken: z.array(z.unknown()) }).safeParse(report);
  return parsed.success ? parsed.data.broken : undefined;
}

/** What the platform said about regressions: the broken list, or that it refused the credential. */
export interface KnownRegression {
  broken?: unknown[];
  /** The platform refused this project's key: said, and the gate fails closed on it. */
  refused?: string;
}

/**
 * Nothing when `reticleRoot` is not linked or the platform did not answer (offline is not a failure);
 * `refused` when it answered and refused the key — a revoked key left CI green and silent.
 */
export async function knownRegression(reticleRoot: string): Promise<KnownRegression> {
  try {
    const cloud = await resolveProjectCloud(
      createNodeFileSystem(),
      reticleRoot,
      homedir(),
      process.env,
    );
    if (null === cloud.config) return {};
    const broken = brokenOf(
      await api('GET', `${cloud.config.url}${REGRESSION_PATH}`, cloud.config.apiKey),
    );
    return broken === undefined ? {} : { broken };
  } catch (error) {
    return error instanceof CredentialRefusedError ? { refused: error.message } : {};
  }
}
