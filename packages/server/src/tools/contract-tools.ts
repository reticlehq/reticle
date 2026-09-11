import { z } from 'zod';
import { sessionRoot } from '../project/session-root.js';
import {
  CapabilitiesSchema,
  ContractReadError,
  FROM_DISK_ARG,
  ReticleCommand,
} from '@reticlehq/core';
import { ReticleTool } from './tool-names.js';
import { asString } from './tools-helpers.js';
import { sessionIdShape, commandOrThrow } from './tool-kit.js';
import { reticleDirPaths, readContract, writeContract } from '../project/reticle-dir.js';
import type { ToolDef, ToolDeps } from './tools.js';

/**
 * The capability-contract tools. `reticle_capabilities` reads the live session, or the
 * git-checked `.reticle/contract.json` when `{ fromDisk:true }`; `reticle_contract_save` persists the
 * live registry to that file (pretty-printed, stable key order — diffable in PRs).
 */

/**
 * Refuse to persist one project's surface into another project's repo.
 *
 * `writeContract` writes to the DAEMON's `.reticle/`, which is the directory the daemon was started
 * in — not the session's project. A daemon started above several apps therefore saves app A's
 * testids into app B's checkout, reports `saved: true`, and hands back a path that looks right. A
 * contract is git-checked and diffable, so that is a change somebody commits.
 *
 * Refuse rather than redirect: a session advertises a projectId, not a project DIRECTORY, so there
 * is no honest way to work out where the correct `.reticle/` lives. Naming both ids and stopping is
 * the whole of what can be said truthfully.
 *
 * Silence is not a mismatch. An unstamped build carries no projectId, and a daemon above an
 * uninitialised directory has none either; neither is evidence of two projects.
 */
function assertSameProject(deps: ToolDeps, sessionId: string | undefined): void {
  const mine = deps.projectId;
  const theirs = deps.sessions.resolve(sessionId).projectId;
  if (mine === undefined || theirs === undefined || mine === theirs) return;
  throw new Error(
    `refusing to save: this session belongs to project '${theirs}', but this daemon writes to ` +
      `project '${mine}' (.reticle/ in the directory it was started in). Saving would put one ` +
      "app's testable surface into another app's git-checked contract. Run a daemon from " +
      `'${theirs}'s own directory and save there.`,
  );
}

export const CONTRACT_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.CAPABILITIES,
    description:
      'The app-advertised testable surface (reticle.describe): testids, signals, stores, and named flows. Call this first to learn what to assert on without reading source. Pass { fromDisk:true } to read the git-checked .reticle/contract.json instead of the live session (a fresh agent can learn the surface with no browser attached).',
    // Every core tool carries one, so an agent reading the surface never has to guess the shape.
    // `fromDisk` is the example deliberately: it is the call that works with nothing attached, which
    // is the state a fresh agent is actually in when it first reads this list.
    example: { [FROM_DISK_ARG]: true },
    inputSchema: { [FROM_DISK_ARG]: z.boolean().optional(), ...sessionIdShape },
    outputSchema: {
      testids: z.array(z.string()),
      signals: z.array(z.string()),
      stores: z.array(z.string()),
      flows: z.array(z.object({ name: z.string(), steps: z.array(z.string()) })),
      source: z
        .string()
        .describe('live = real-time from the browser; disk = last saved contract.json'),
      // fromDisk carries when the contract was generated; both paths carry the app's declared governance
      // (owner/safety/scope) when present. Undeclared, they were stripped on a validating profile — a
      // governance-gated app lost its policy block, and disk reads lost their freshness stamp.
      generatedAt: z.number().optional(),
      governance: z.unknown().optional(),
    },
    handler: async (deps, args) => {
      if (true === args[FROM_DISK_ARG]) {
        const r = await readContract(deps.fs, sessionRoot(deps, asString(args['sessionId'])));
        if (!r.ok)
          throw new Error(
            r.reason === ContractReadError.MISSING
              ? 'no .reticle/contract.json on disk — run reticle_contract_save first (or omit fromDisk to read the live session)'
              : '.reticle/contract.json is malformed — fix or regenerate it with reticle_contract_save',
          );
        return { ...r.capabilities, source: 'disk', generatedAt: r.generatedAt };
      }
      const caps = await commandOrThrow(
        deps,
        asString(args['sessionId']),
        ReticleCommand.CAPABILITIES,
        {},
      );
      return { ...(caps as object), source: 'live' };
    },
  },
  {
    name: ReticleTool.CONTRACT_SAVE,
    description:
      "Persist the app's live capability registry (reticle.describe) to .reticle/contract.json — git-checked, diffable, readable by a fresh agent via reticle_capabilities({ fromDisk:true }). Returns { path, counts }.",
    inputSchema: { ...sessionIdShape },
    outputSchema: {
      saved: z.boolean(),
      path: z.string(),
      testidCount: z.number(),
      signalCount: z.number(),
    },
    handler: async (deps, args) => {
      const res = await commandOrThrow(
        deps,
        asString(args['sessionId']),
        ReticleCommand.CAPABILITIES,
        {},
      );
      const caps = CapabilitiesSchema.parse(res);
      assertSameProject(deps, asString(args['sessionId']));
      const root = sessionRoot(deps, asString(args['sessionId']));
      await writeContract(deps.fs, root, caps, deps.now);
      return {
        saved: true,
        path: reticleDirPaths(root).contract,
        testidCount: caps.testids.length,
        signalCount: caps.signals.length,
      };
    },
  },
];
