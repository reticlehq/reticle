import { z } from 'zod';
import {
  CapabilitiesSchema,
  ContractReadError,
  FROM_DISK_ARG,
  IrisCommand,
} from '@syrin/iris-protocol';
import { IrisTool } from './tool-names.js';
import { asString } from './tools-helpers.js';
import { sessionIdShape, commandOrThrow } from './tool-kit.js';
import { irisDirPaths, readContract, writeContract } from '../project/iris-dir.js';
import type { ToolDef } from './tools.js';

/**
 * The capability-contract tools. `iris_capabilities` reads the live session, or the
 * git-checked `.iris/contract.json` when `{ fromDisk:true }`; `iris_contract_save` persists the
 * live registry to that file (pretty-printed, stable key order — diffable in PRs).
 */
export const CONTRACT_TOOLS: ToolDef[] = [
  {
    name: IrisTool.CAPABILITIES,
    description:
      'The app-advertised testable surface (iris.describe): testids, signals, stores, and named flows. Call this first to learn what to assert on without reading source. Pass { fromDisk:true } to read the git-checked .iris/contract.json instead of the live session (a fresh agent can learn the surface with no browser attached).',
    inputSchema: { [FROM_DISK_ARG]: z.boolean().optional(), ...sessionIdShape },
    outputSchema: {
      testids: z.array(z.string()),
      signals: z.array(z.string()),
      stores: z.array(z.string()),
      flows: z.array(z.object({ name: z.string(), steps: z.array(z.string()) })),
      source: z
        .string()
        .describe('live = real-time from the browser; disk = last saved contract.json'),
    },
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
      const caps = await commandOrThrow(
        deps,
        asString(args['sessionId']),
        IrisCommand.CAPABILITIES,
        {},
      );
      return { ...(caps as object), source: 'live' };
    },
  },
  {
    name: IrisTool.CONTRACT_SAVE,
    description:
      "Persist the app's live capability registry (iris.describe) to .iris/contract.json — git-checked, diffable, readable by a fresh agent via iris_capabilities({ fromDisk:true }). Returns { path, counts }.",
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
        IrisCommand.CAPABILITIES,
        {},
      );
      const caps = CapabilitiesSchema.parse(res);
      await writeContract(deps.fs, deps.irisRoot, caps, deps.now);
      return {
        saved: true,
        path: irisDirPaths(deps.irisRoot).contract,
        testidCount: caps.testids.length,
        signalCount: caps.signals.length,
      };
    },
  },
];
