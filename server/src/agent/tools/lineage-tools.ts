/**
 * `reticle_lineage` — where a runtime value came from.
 *
 * When a verdict is `no`, or a contradiction fires, the next question is always the same. Today an
 * agent answers it by hand: `reticle_state` for the value, `reticle_network` for the requests,
 * `reticle_observe` for the window, then correlates the three itself — spending tokens and judgement
 * on a join the daemon can do once from data it already holds.
 *
 * READ-ONLY BY CONSTRUCTION. It produces no verdict, so it is registered in `TOOLS` and deliberately
 * NOT in the verification set, and nothing on an assert path reaches it. The decision logic lives in
 * `events/lineage.ts` and is where the honesty rules are argued; this file is the surface.
 */

import { z } from 'zod';
import { ReticleTool } from '@reticlehq/core';
import type { ToolDef, ToolDeps } from './tools.js';
import { traceLineage } from '@reticlehq/engine/question/lineage.js';
import { asString } from '@reticlehq/core';
import { cursorSchema } from './numeric-bounds.js';

export const LINEAGE_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.LINEAGE,
    example: { path: 'user.profile.name' },
    description:
      'Trace BACKWARDS from a runtime value: which state change set it, which signal preceded that, and which request preceded the signal. Read-only — it draws no verdict and changes nothing. The state change is OBSERVED; every link above it is an INFERENCE from timing and says so in its own text. Where several candidates could explain a link it names ALL of them rather than choosing, because timing alone cannot justify the choice — so a chain here is a place to look, never a proven cause. Use it after a `no` verdict or a contradiction, instead of correlating reticle_state, reticle_network and reticle_observe by hand.',
    inputSchema: {
      path: z
        .string()
        .describe('The state path to trace, e.g. "user.profile.name". Matched as a substring.'),
      value: z
        .string()
        .optional()
        .describe(
          'Narrow to the change that set THIS value, when the path changed more than once.',
        ),
      since: cursorSchema
        .optional()
        .describe('Only consider events after this cursor (from an act or observe result).'),
      ...{},
    },
    outputSchema: {
      found: z
        .boolean()
        .describe('False when the path was never seen to change — not the same as an empty chain.'),
      chain: z
        .array(
          z.object({
            kind: z.string(),
            text: z.string(),
            observed: z.boolean(),
            candidates: z.array(z.string()).optional(),
          }),
        )
        .describe(
          'Most recent change first. `observed` is true only for events we hold; every join is false.',
        ),
      note: z
        .string()
        .optional()
        .describe('Why the chain stops where it does, when it stops early.'),
    },
    handler: (deps: ToolDeps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const since = 'number' === typeof args['since'] ? args['since'] : 0;
      const path = asString(args['path']) ?? '';
      const value = asString(args['value']);
      return Promise.resolve(
        traceLineage(session.eventsSince(since), {
          path,
          ...(value === undefined ? {} : { value }),
        }),
      );
    },
  },
];
