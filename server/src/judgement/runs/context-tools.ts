import { z } from 'zod';
import { type JournalAction, type ReticleEvent } from '@reticlehq/core';
import { runContextFor } from './artifact/run-context.js';
import { gapSummary } from './artifact/gap-summary.js';
import { openSessionIntents } from '@/memory/intent/open-intents.js';
import { ReticleTool } from '@reticlehq/core';
import { sessionIdShape } from '@/surface/tools/tool-kit.js';
import { asString } from '@reticlehq/core';
import { resumeFromDisk, resumeLines } from './resume.js';
import { sessionRoot } from '@/memory/project/session-root.js';
import type { ToolDef, ToolDeps } from '@/surface/tools/tool-kit.js';

/**
 * What this run has established, asked for by the one party that knows when it is needed.
 *
 * Reticle holds the trajectory: the journal, the verdicts, the intent ledger. The agent holds a copy
 * in its context window, and that copy is the one that disappears — at a compaction, at the end of a
 * turn, at the handover to a sub-agent. Reticle's does not disappear at the same moment. So this is
 * not a competing memory; it is the ground truth compaction destroyed, handed back on request.
 *
 * PULLED, not pushed onto every session-bound tool response: only the agent knows when its context
 * is gone, so it asks once at that moment and pays once.
 */

/** What the run has established, and where each part of it came from. */
const CONTEXT_OUTPUT_SCHEMA = {
  resume: z
    .string()
    .optional()
    .describe(
      'Only with `compact: true`: the whole answer in under ~1k tokens — the tab and route, the request, every claim that FAILED or is NOT PROVED (by its latest verdict), what held, open intents, app notes and the rules. Read it after a compaction instead of trusting your summary.',
    ),
  step: z
    .number()
    .optional()
    .describe(
      'How many actions this run has dispatched. Counted off the journal, not a counter of its own.',
    ),
  established: z
    .array(z.unknown())
    .optional()
    .describe(
      'What Reticle OBSERVED, folded and capped, each `{ key, fact, source?, doc?, epoch? }`. `key` is the subject, so re-observing it supersedes rather than appends. Anything seen under a replaced document or a pre-edit epoch is already gone from this list.',
    ),
  proven: z
    .array(z.unknown())
    .optional()
    .describe(
      'Claims a verdict already settled, each `{ claim, verified, source?, doc?, epoch? }`. Read this before re-driving something: re-proving it is slow, and assuming it is a false green.',
    ),
  gap: z
    .object({})
    .passthrough()
    .optional()
    .describe(
      'The distance between what was claimed and what held, over THIS session: `{ claims, held, failed, undecided, nothingToProve, undecidedBy, falseGreensCaught, failures }`. `undecidedBy` says WHO can act on each unknown — environment (wait), code (fix the app), harness (fix Reticle or the call), could-not-see (look again). Folded from the same journal as everything else here, so it cannot disagree with it.',
    ),
  remaining: z
    .array(z.string())
    .optional()
    .describe(
      'The intents from .reticle/intent/ that no verdict has discharged. Derived from the ledger, never a guess at what you meant to do next.',
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

/** The resume block for the live session, or the newest one on disk when none is connected. */
async function resumeFor(
  deps: ToolDeps,
  sessionId: string | undefined,
  actions: JournalAction[],
): Promise<string[]> {
  let live: { id: string; url: string; cursor: number } | undefined;
  try {
    const session = deps.sessions.resolve(sessionId);
    live = { id: session.id, url: session.url, cursor: session.elapsed() };
  } catch {
    live = undefined;
  }
  let root: string;
  try {
    root = sessionRoot(deps, live?.id);
  } catch {
    // No project can be named for this call: the live journal is all there is to fold.
    return resumeLines({ actions, openIntents: [], notes: [] });
  }
  return resumeFromDisk({
    root,
    now: deps.now(),
    fs: deps.fs,
    // The live journal; with nothing connected there is no live one to fold, and the CLI's
    // `reticle context --compact` is the reader for a session that has gone.
    readActions: () => Promise.resolve(actions),
    ...(live === undefined
      ? {}
      : { sessionId: live.id, route: routeOf(live.url), cursor: live.cursor }),
  });
}

/** The path of a page URL, or the URL as given. */
function routeOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export const CONTEXT_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.CONTEXT,
    description:
      'What THIS run has already established, so you do not rediscover it. Call it when your own copy is gone: right after a compaction, at the top of a fresh sub-agent, or at the start of a turn you did not begin. Returns `established` (what Reticle OBSERVED, with the source file:line where one was reported), `proven` (claims a verdict already settled, so you neither re-prove them nor assume them) and `remaining` (the intents from .reticle/intent/ that nothing has discharged). It is a FOLD over the journal, never a second store, so it cannot disagree with the ledger. Bounded and superseding rather than accumulating, and anything observed under a replaced document or before your last source edit is already dropped rather than presented as current. Only what Reticle observed goes in: it never reports what you intended or believed.',
    example: {},
    inputSchema: {
      compact: z
        .boolean()
        .optional()
        .describe('After a compaction: one bounded `resume` text instead of the structured fold.'),
      ...sessionIdShape,
    },
    outputSchema: CONTEXT_OUTPUT_SCHEMA,
    handler: async (deps: ToolDeps, args) => {
      const sessionId = asString(args['sessionId']);
      const evidence = await evidenceFor(deps, sessionId);
      if (true === args['compact'])
        return { resume: (await resumeFor(deps, sessionId, evidence.actions)).join('\n') };
      const context = runContextFor({
        ...evidence,
        intents: await openSessionIntents(deps, sessionId),
      });
      /*
       * The gap rides on `reticle_context` rather than on a tool of its own.
       *
       * This is the one call an agent makes when it needs to know what the run has already settled,
       * which is exactly the moment "and what did NOT settle, and whose problem each of those is"
       * is worth reading. It is folded from the same journal the rest of this response is folded
       * from, so it costs one more pass over an array already in hand and cannot disagree with the
       * `proven` list beside it.
       */
      return { ...context, gap: gapSummary(evidence.actions) };
    },
  },
];
