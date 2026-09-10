import { dirname } from 'node:path';
import type { FileSystemPort } from '../project/fs-port.js';
import { reticleDirPaths } from '../project/reticle-dir.js';
import { FlakeFileSchema, emptyRecord, isFlaky, recordOutcome, type FlakeLedger } from './flake.js';

const FLAKE_FILE_VERSION = 1;

/**
 * Persists the per-flow flake ledger at `.reticle/flake.json`. Local single-project memory (stays OSS —
 * OSS-VS-SERVER). Loads never throw: missing/malformed/wrong-version degrades to an empty ledger, so
 * a bad file never blocks a gate — it just re-learns flakiness. `record` accrues one unchanged-code
 * replay outcome; `flakyFlows` is what the gate quarantines.
 */
export class FlakeStore {
  readonly #fs: FileSystemPort;
  readonly #path: string;

  constructor(fs: FileSystemPort, root: string) {
    this.#fs = fs;
    this.#path = reticleDirPaths(root).flake;
  }

  async load(): Promise<FlakeLedger> {
    let text: string;
    try {
      text = await this.#fs.readFile(this.#path);
    } catch (error) {
      if (this.#fs.isNotFound(error)) return {};
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {};
    }
    const result = FlakeFileSchema.safeParse(parsed);
    return result.success ? result.data.flows : {};
  }

  async save(ledger: FlakeLedger): Promise<void> {
    await this.#fs.mkdir(dirname(this.#path));
    const body = `${JSON.stringify({ version: FLAKE_FILE_VERSION, flows: ledger }, null, 2)}\n`;
    const tmp = `${this.#path}.tmp`;
    await this.#fs.writeFile(tmp, body);
    await this.#fs.rename(tmp, this.#path);
  }

  /** Accrue one unchanged-code replay outcome for a flow and persist. */
  async record(flow: string, passed: boolean): Promise<void> {
    const ledger = await this.load();
    ledger[flow] = recordOutcome(ledger[flow] ?? emptyRecord(), passed);
    await this.save(ledger);
  }

  /** The flows currently quarantined as flaky — what the gate excludes from blocking. */
  async flakyFlows(): Promise<string[]> {
    const ledger = await this.load();
    return Object.entries(ledger)
      .filter(([, record]) => isFlaky(record))
      .map(([flow]) => flow);
  }
}
