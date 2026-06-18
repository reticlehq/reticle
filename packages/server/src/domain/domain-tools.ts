import { z } from 'zod';
import type { FlowFile } from '@syrin/iris-protocol';
import { IrisTool } from '../tools/tool-names.js';
import { readContract } from '../project/iris-dir.js';
import { buildDomainModel } from './domain-model.js';
import type { ToolDef, ToolDeps } from '../tools/tools.js';

/**
 * iris_domain — the "learn the app before testing it" tool. Synthesizes every saved flow + the
 * registered capabilities into a compact domain model: the journeys, what each asserts, and the
 * GAPS (declared signals/testids no flow verifies). An agent reads this once instead of crawling
 * the whole app or reading all the source — and it points straight at untested intent.
 */
export const DOMAIN_TOOLS: ToolDef[] = [
  {
    name: IrisTool.DOMAIN,
    description:
      'Read the app domain model BEFORE testing: every saved flow with its assertion grade, the consequence that MUST hold for it (mustHold = what it actually tests), the anchors/signals it exercises, plus GAPS — declared signals/testids that NO flow asserts (untested intent), and flows that assert no observable consequence. Use this to decide what to test and where the real risk is, instead of crawling the whole app. Reads .iris/flows/ + .iris/contract.json (no browser needed).',
    inputSchema: {},
    outputSchema: {
      flowCount: z.number(),
      flows: z.array(
        z.object({
          name: z.string(),
          steps: z.number(),
          grade: z.string(),
          asserts: z.boolean(),
          mustHold: z
            .string()
            .optional()
            .describe(
              'The success consequence that must hold for this flow (what it actually tests).',
            ),
          warning: z.string().optional(),
          signals: z.array(z.string()),
          testids: z.array(z.string()),
        }),
      ),
      declared: z.object({
        testids: z.number(),
        signals: z.array(z.string()),
        stores: z.array(z.string()),
      }),
      coverage: z.object({
        asserted: z.number(),
        presenceOnly: z.number(),
        assertionFree: z.number(),
      }),
      gaps: z.object({
        unassertedFlows: z.array(z.string()),
        declaredUntestedSignals: z.array(z.string()),
        declaredUntestedTestids: z.array(z.string()),
      }),
      riskRanked: z
        .array(z.string())
        .describe(
          'Flow names worst-risk first (run history + assertion quality). Test these first.',
        ),
      summary: z.string(),
    },
    handler: async (deps: ToolDeps) => {
      const names = await deps.flows.list();
      const flows: FlowFile[] = [];
      for (const name of names) {
        const loaded = await deps.flows.load(name);
        if (loaded.ok) flows.push(loaded.value);
      }
      const contract = await readContract(deps.fs, deps.irisRoot);
      const project = await deps.project.read();
      const runs = project.ok ? project.file.runs : [];
      return buildDomainModel(flows, contract.ok ? contract.capabilities : null, runs);
    },
  },
];
