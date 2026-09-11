import { z } from 'zod';
import { dirname } from 'node:path';
import type { FileSystemPort } from '../project/fs-port.js';
import { reticleDirPaths } from '../project/reticle-dir.js';
import { RouteEnvelopeSchema, type RouteEnvelope } from './envelope.js';

/** Bumped on any breaking change to the persisted envelope shape (matches the runs/contract convention). */
const ENVELOPE_FILE_VERSION = 1;

const EnvelopeFileSchema = z.object({
  version: z.literal(ENVELOPE_FILE_VERSION),
  routes: z.record(RouteEnvelopeSchema),
});

/**
 * Persists the learned per-route envelopes at `.reticle/envelopes.json`. Local, single-project statistics
 * (single-player memory stays OSS — OSS-VS-SERVER). Loads never throw: a missing, malformed, or
 * wrong-version file degrades to no envelopes, so a bad baseline can never crash a drive; the deviation
 * report just falls back to the causal summary until the envelope rebuilds.
 */
export class EnvelopeStore {
  readonly #fs: FileSystemPort;
  readonly #path: string;

  constructor(fs: FileSystemPort, root: string) {
    this.#fs = fs;
    this.#path = reticleDirPaths(root).envelopes;
  }

  /** Absolute path of the backing file — the key a caller uses to serialize its read-modify-write. */
  get path(): string {
    return this.#path;
  }

  async load(): Promise<Map<string, RouteEnvelope>> {
    let text: string;
    try {
      text = await this.#fs.readFile(this.#path);
    } catch (error) {
      if (this.#fs.isNotFound(error)) return new Map();
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return new Map();
    }
    const result = EnvelopeFileSchema.safeParse(parsed);
    if (!result.success) return new Map();
    return new Map(Object.entries(result.data.routes));
  }

  async save(envelopes: ReadonlyMap<string, RouteEnvelope>): Promise<void> {
    await this.#fs.mkdir(dirname(this.#path));
    const routes: Record<string, RouteEnvelope> = {};
    for (const [route, envelope] of envelopes) routes[route] = envelope;
    const body = `${JSON.stringify({ version: ENVELOPE_FILE_VERSION, routes }, null, 2)}\n`;
    // Atomic publish: write a temp sibling then rename, so a crash never leaves a half-written baseline.
    const tmp = `${this.#path}.tmp`;
    await this.#fs.writeFile(tmp, body);
    await this.#fs.rename(tmp, this.#path);
  }
}
