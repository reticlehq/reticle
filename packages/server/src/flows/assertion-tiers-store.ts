import { dirname } from 'node:path';
import { z } from 'zod';
import type { FlowExpect } from '@reticlehq/core';
import type { FileSystemPort } from '../project/fs-port.js';
import { reticleDirPaths } from '../project/reticle-dir.js';
import { withFileLock } from '../project/file-lock.js';
import type { StepExpect } from './assertion-integrity.js';

/**
 * The anti-reward-hacking baseline. Detecting an assertion DOWNGRADE requires knowing what the
 * flow asserted the last time it PASSED — otherwise a weakened flow simply looks like a flow that always
 * asserted little. Flows are git-checked and agent-editable, so we cannot trust the file itself as its own
 * history.
 *
 * So: on every passing replay we record that flow's per-step assertion shape here, and the gate diffs the
 * current file against it. Recorded only on PASS, deliberately — a failing run must never become the
 * baseline a later weakening is measured against.
 *
 * Loads never throw: a missing/corrupt ledger degrades to "no baseline", which means no downgrade can be
 * claimed. Failing OPEN is right here — accusing an agent of gaming the gate on the strength of an
 * unreadable file would be worse than missing one downgrade.
 */

const AssertionTiersFileSchema = z.object({
  version: z.literal(1),
  flows: z.record(
    z.object({
      steps: z.array(z.object({ step: z.number(), expect: z.unknown().optional() })),
      /** Source files this flow covered when it last passed — lets the gate scope DELETION findings to
       * the files that actually changed, instead of flagging every intentionally-removed flow. */
      sources: z.array(z.string()).default([]),
    }),
  ),
});

interface FlowBaseline {
  steps: StepExpect[];
  sources: string[];
}
type FlowTiers = Record<string, FlowBaseline>;

const ASSERTION_TIERS_VERSION = 1;

export class AssertionTiersStore {
  readonly #fs: FileSystemPort;
  readonly #path: string;

  constructor(fs: FileSystemPort, root: string) {
    this.#fs = fs;
    this.#path = reticleDirPaths(root).tiers;
  }

  async load(): Promise<FlowTiers> {
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
    const result = AssertionTiersFileSchema.safeParse(parsed);
    if (!result.success) return {};
    const out: FlowTiers = {};
    for (const [name, entry] of Object.entries(result.data.flows)) {
      out[name] = {
        steps: entry.steps.map((s) => ({
          step: s.step,
          ...(s.expect === undefined ? {} : { expect: s.expect as FlowExpect }),
        })),
        sources: entry.sources,
      };
    }
    return out;
  }

  async save(tiers: FlowTiers): Promise<void> {
    await this.#fs.mkdir(dirname(this.#path));
    const body = `${JSON.stringify({ version: ASSERTION_TIERS_VERSION, flows: tiers }, null, 2)}\n`;
    const tmp = `${this.#path}.tmp`;
    await this.#fs.writeFile(tmp, body);
    await this.#fs.rename(tmp, this.#path);
  }

  /** Record one flow's assertion shape + covered sources after it PASSED. Never breaks a replay. */
  async recordPassing(
    name: string,
    steps: readonly StepExpect[],
    sources: readonly string[] = [],
  ): Promise<void> {
    try {
      // Serialized per file: a fresh store instance is created per flow (flow-replay-run), so parallel
      // passing replays would otherwise each load the same baseline, add only THEIR flow, and the last
      // save would drop every other flow's baseline — the downgrade-detection gate silently losing
      // coverage. The lock is keyed by path, so it serializes across those distinct instances.
      await withFileLock(this.#path, async () => {
        const all = await this.load();
        all[name] = {
          steps: steps.map((s) => ({
            step: s.step,
            ...(s.expect === undefined ? {} : { expect: s.expect }),
          })),
          sources: [...sources],
        };
        await this.save(all);
      });
    } catch {
      // a ledger write must never fail a green replay
    }
  }
}
