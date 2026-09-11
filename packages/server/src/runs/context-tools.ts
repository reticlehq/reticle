import { z } from 'zod';
import { type JournalAction, type ReticleEvent } from '@reticlehq/core';
import { runContextFor } from './run-context.js';
import { openSessionIntents } from '../intent/open-intents.js';
import { ReticleTool } from '../tools/tool-names.js';
import { sessionIdShape } from '../tools/tool-kit.js';
import { asString } from '../tools/tools-helpers.js';
import type { ToolDef, ToolDeps } from '../tools/tool-kit.js';

/**
 * What this run has established, asked for by the one party that knows when it is needed.
 *
 * Reticle holds the trajectory: the journal, the verdicts, the intent ledger. The agent holds a copy
 * in its context window, and that copy is the one that disappears — at a compaction, at the end of a
 * turn, at the handover to a sub-agent. Reticle's does not disappear at the same moment. So this is
 * not a competing memory; it is the ground truth compaction destroyed, handed back on request.
 *
 * ## Why it is PULLED
 *
 * The same content was once pushed onto every session-bound tool response. It cost +136% on a
 * verdict and was cut, because most of the time the agent still had the context and we were paying
 * on every call to duplicate what it knew. Nobody but the agent can tell when that stops being true.
 * So the agent asks, once, at the moment it knows its own memory is gone, and pays once.
 *
 * ## Why it is on the EXTENDED surface rather than the default
 *
 * The default surface is a hard COUNT — editors budget tools across every connected MCP server, so a
 * slot taken here is taken from a tool that has already earned it, and nothing on that list has been
 * demoted for this. The claim behind this tool is unmeasured, which is the same test `reticle_intent`
 * and the `reticle_capabilities` demotion were held to, and it fails that test today.
 *
 * The reachability argument is also stronger here than for most of the cold tail. The caller is,
 * by construction, an agent that has just lost its context and is re-reading the tool list it was
 * handed this turn — so `reticle_tools` (advertised on every surface) is exactly the call it is
 * already going to make, and this tool is one `reticle_run` hop behind it. A tool that is only useful
 * after a discovery step, to a caller who is already performing a discovery step, is the cheapest
 * possible thing to leave off the hot list. It moves to the default surface when a measurement says
 * the pull happens often enough to be worth a permanent slot, and not before.
 */

/** What the run has established, and where each part of it came from. */
const CONTEXT_OUTPUT_SCHEMA = {
  step: z
    .number()
    .describe(
      'How many actions this run has dispatched. Counted off the journal, not a counter of its own.',
    ),
  established: z
    .array(z.unknown())
    .describe(
      'What Reticle OBSERVED, folded and capped, each `{ key, fact, source?, doc?, epoch? }`. `key` is the subject, so re-observing it supersedes rather than appends. Anything seen under a replaced document or a pre-edit epoch is already gone from this list.',
    ),
  proven: z
    .array(z.unknown())
    .describe(
      'Claims a verdict already settled, each `{ claim, verified, source?, doc?, epoch? }`. Read this before re-driving something: re-proving it is slow, and assuming it is a false green.',
    ),
  remaining: z
    .array(z.string())
    .describe(
      'The intents from .reticle/intent.json that no verdict has discharged. Derived from the ledger, never a guess at what you meant to do next.',
    ),
};

/** The ledger and the live page state this run is folded out of. `[]`/undefined when nothing is connected. */
async function evidenceFor(
  deps: ToolDeps,
  sessionId: string | undefined,
): Promise<{
  actions: JournalAction[];
  events: ReticleEvent[];
  currentDocumentId: string | undefined;
  currentEditEpoch: number | undefined;
}> {
  try {
    const session = deps.sessions.resolve(sessionId);
    return {
      actions: await session.readJournalActions(),
      events: await session.queryEvents({}),
      currentDocumentId: session.currentDocumentId,
      currentEditEpoch: session.currentEditEpoch,
    };
  } catch {
    // `resolve` throws when nothing is connected, when the id names no session, and when several are
    // connected and none was named. All three mean the same thing here: there is no run to report,
    // and an empty context is the honest answer rather than a reason to fail the call.
    return {
      actions: [],
      events: [],
      currentDocumentId: undefined,
      currentEditEpoch: undefined,
    };
  }
}

export const CONTEXT_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.CONTEXT,
    description:
      'What THIS run has already established, so you do not rediscover it. Call it when your own copy is gone: right after a compaction, at the top of a fresh sub-agent, or at the start of a turn you did not begin. Returns `established` (what Reticle OBSERVED, with the source file:line where one was reported), `proven` (claims a verdict already settled, so you neither re-prove them nor assume them) and `remaining` (the intents from .reticle/intent.json that nothing has discharged). It is a FOLD over the journal, never a second store, so it cannot disagree with the ledger. Bounded and superseding rather than accumulating, and anything observed under a replaced document or before your last source edit is already dropped rather than presented as current. Only what Reticle observed goes in: it never reports what you intended or believed.',
    example: {},
    inputSchema: { ...sessionIdShape },
    outputSchema: CONTEXT_OUTPUT_SCHEMA,
    handler: async (deps: ToolDeps, args) => {
      const sessionId = asString(args['sessionId']);
      const evidence = await evidenceFor(deps, sessionId);
      return runContextFor({ ...evidence, intents: await openSessionIntents(deps, sessionId) });
    },
  },
];
