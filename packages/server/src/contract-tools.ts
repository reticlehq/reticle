import { z } from 'zod';
import {
  CapabilitiesSchema,
  ContractReadError,
  FROM_DISK_ARG,
  IrisCommand,
} from '@syrin/iris-protocol';
import { IrisTool } from './tool-names.js';
import { asString } from './tools-helpers.js';
import { irisDirPaths, readContract, writeContract } from './iris-dir.js';
import type { ToolDef, ToolDeps } from './tools.js';

const sessionIdShape = { sessionId: z.string().optional() };

/** Unwrap a browser command result or throw its error so the agent sees a clean failure. */
async function commandOrThrow(
  deps: ToolDeps,
  sessionId: string | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const session = deps.sessions.resolve(sessionId);
  const result = await session.command(name, args);
  if (!result.ok) throw new Error(result.error ?? `command '${name}' failed`);
  return result.result;
}

/**
 * M8 Stage A: the capability-contract tools. `iris_capabilities` reads the live session, or the
 * git-checked `.iris/contract.json` when `{ fromDisk:true }`; `iris_contract_save` persists the
 * live registry to that file (pretty-printed, stable key order — diffable in PRs).
 */
export const CONTRACT_TOOLS: ToolDef[] = [
  {
    name: IrisTool.CAPABILITIES,
    description:
      'The app-advertised testable surface (iris.describe): testids, signals, stores, and named flows. Call this first to learn what to assert on without reading source. Pass { fromDisk:true } to read the git-checked .iris/contract.json instead of the live session (a fresh agent can learn the surface with no browser attached).',
    inputSchema: { [FROM_DISK_ARG]: z.boolean().optional(), ...sessionIdShape },
    handler: async (deps, args) => {
      if (args[FROM_DISK_ARG] === true) {
        const r = await readContract(deps.fs, deps.irisRoot);
        if (!r.ok)
          throw new Error(
            r.reason === ContractReadError.MISSING
              ? 'no .iris/contract.json on disk — run iris_contract_save first (or omit fromDisk to read the live session)'
              : '.iris/contract.json is malformed — fix or regenerate it with iris_contract_save',
          );
        return { ...r.capabilities, source: 'disk', generatedAt: r.generatedAt };
      }
      return commandOrThrow(deps, asString(args['sessionId']), IrisCommand.CAPABILITIES, {});
    },
  },
  {
    name: IrisTool.CONTRACT_SAVE,
    description:
      "Persist the app's live capability registry (iris.describe) to .iris/contract.json — git-checked, diffable, readable by a fresh agent via iris_capabilities({ fromDisk:true }). Returns { path, counts }.",
    inputSchema: { ...sessionIdShape },
    handler: async (deps, args) => {
      const res = await commandOrThrow(
        deps,
        asString(args['sessionId']),
        IrisCommand.CAPABILITIES,
        {},
      );
      const caps = CapabilitiesSchema.parse(res);
      await writeContract(deps.fs, deps.irisRoot, caps, deps.now);
      return {
        path: irisDirPaths(deps.irisRoot).contract,
        counts: {
          testids: caps.testids.length,
          signals: caps.signals.length,
          stores: caps.stores.length,
          flows: caps.flows.length,
        },
      };
    },
  },
];
