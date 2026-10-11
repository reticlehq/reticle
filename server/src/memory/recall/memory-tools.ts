/**
 * `reticle_memory` — ask the project what it already knows.
 *
 * Shared memory reached three callers before this one: the sync writes it, flow replay consults it
 * automatically, and `reticle memory` prints it at a terminal. The one who could not ask was the
 * agent doing the work — mid-drive, holding a question, with a whole tool surface and nothing on it
 * for "what has this team already established about checkout?".
 *
 * That matters twice over. An agent that can read the corpus stops re-deriving what a colleague
 * proved last week; and because the read is attributed, the coverage map's fetch counts finally
 * measure something rather than staying at zero because consulting the corpus was a separate act.
 */
import { z } from 'zod';
import { ReticleTool } from '@reticlehq/core';
import { countSchema } from '@/surface/tools/args/numeric-bounds.js';
import { sessionIdShape } from '@/surface/tools/tool-kit.js';
import { asNumber, asString } from '@reticlehq/core';
import { sessionRoot } from '@/memory/project/session-root.js';
import type { ToolDef, ToolDeps } from '@/surface/tools/tool-kit.js';
import { MemoryUnavailable, readProjectMemory } from './project-memory.js';
import {
  MemoryAction,
  addMemoryStatement,
  fetchPlatformFlow,
  pushFlow,
  setAsideStatement,
} from './platform-memory.js';
import { flowsForSession } from '@/language/flows/flow-store-for-session.js';
import { safeSessionTarget } from '@/memory/project/session-root.js';
import { homedir } from 'node:os';

const NEEDS_NAME = 'needs `name`: the flow’s name';
const NEEDS_STATEMENT = 'needs `subject` and `statement`';

/**
 * Enough to orient on, not enough to flood a context.
 *
 * A busy subject on a real project runs to dozens of statements; an agent asking a question wants
 * the ones that settle it. `total` always rides along, so the cap is never silent.
 */
const DEFAULT_LIMIT = 10;

/** What to do next, per reason. A refusal that does not say how to fix it is a dead end. */
const ADVICE: Record<MemoryUnavailable, string> = {
  [MemoryUnavailable.NOT_LINKED]:
    'this project is not linked to a Reticle workspace, so there is no shared memory to read. Run `npx @reticlehq/server login` in the project to link it.',
  [MemoryUnavailable.DISABLED]:
    'this project is linked but memory sync is turned off in .reticle/cloud.json, so nothing is being shared. Enable `sync.memory` to use it.',
  [MemoryUnavailable.UNREACHABLE]:
    'the workspace could not be reached, or refused the key. Nothing is wrong with this project — try again, or check the link with `reticle status`.',
  [MemoryUnavailable.UNVERIFIED]:
    'the server answered, but the answer could not be shown to be about THIS project, so none of it is being reported. This is not an empty corpus: do NOT conclude this project knows nothing. Check the link with `reticle status`, and retry once the workspace is reachable.',
  [MemoryUnavailable.UNREADABLE]:
    'the workspace answered about THIS project, but the body was a shape this build cannot read entries out of. Retrying will not change it — this is not an empty corpus and not a link problem. Check the workspace version, and that `reticle runs memory` from the same terminal returns a `{ projectId, entries }` body.',
};

export const MEMORY_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.MEMORY,
    description:
      'Ask what THIS PROJECT already knows — the shared memory its team has built up, written by every engineer who verified something and readable by every agent since. Use it BEFORE re-deriving how a feature is supposed to behave: a colleague may already have proved it, and a statement marked `proved` was established by a real verdict rather than written down. With { subject } it narrows to one area (a flow name, or a route like "checkout"); without, it returns across the project. Each entry carries the flow and the source file it is about, so a claim can be checked. The read is recorded as an agent consultation, which is what the dashboard\'s per-flow fetch counts are built from. Returns { subject, known, total } or { error, reason, advice } when this project is not linked to a workspace. ' +
      'Other actions, each answered by the platform: "flow" { name } reads one saved flow from the platform (a teammate\'s too); "add" { subject, statement } writes a statement (lands as proposed); "push-flow" { name } uploads this machine\'s saved flow, replacing the platform copy; "set-aside" { id } marks a statement stale so nobody relies on it (it is kept, not deleted).',
    inputSchema: {
      action: z.enum(Object.values(MemoryAction) as [MemoryAction, ...MemoryAction[]]).optional(),
      name: z.string().optional().describe('flow / push-flow: the flow name.'),
      statement: z.string().optional().describe('add: what is true, in prose.'),
      id: z.string().optional().describe('set-aside: the statement id.'),
      subject: z
        .string()
        .optional()
        .describe(
          'Narrow to one area — a flow name ("checkout-pay") or a route segment ("issues"). Omit to read across the whole project. Subjects come from the coverage map; an unknown one returns nothing rather than erroring.',
        ),
      limit: countSchema
        .optional()
        .describe(
          `Most relevant N statements. Defaults to ${String(DEFAULT_LIMIT)}. Proved statements rank first, so a small limit still returns the settled ones. \`total\` always reports the true count.`,
        ),
      ...sessionIdShape,
    },
    outputSchema: {
      flow: z.unknown().optional(),
      added: z.unknown().optional(),
      pushed: z.string().optional(),
      setAside: z.string().optional(),
      subject: z.string().nullable().optional(),
      known: z.array(z.unknown()).optional(),
      total: z.number().optional(),
      error: z.string().optional(),
      reason: z.string().optional(),
      advice: z.string().optional(),
    },
    handler: async (deps: ToolDeps, args) => {
      /*
       * The APP's root, not the daemon's.
       *
       * `deps.reticleRoot` is wherever the daemon was launched, which for a user-scoped MCP
       * registration is almost never the project being driven — so the link file it reads is the
       * wrong one or absent, and every project silently reads as "not attached". The same defect
       * has now been fixed three times in this codebase; routing through sessionRoot is what stops
       * a fourth.
       */
      const sid = asString(args['sessionId']);
      const root = sessionRoot(deps, sid);
      const subject = asString(args['subject']);
      const action = asString(args['action']) ?? MemoryAction.READ;
      const name = asString(args['name']);
      if (MemoryAction.SET_ASIDE === action) {
        const id = asString(args['id']);
        if (id === undefined || 0 === id.trim().length)
          return { error: `${action} needs \`id\`: the statement id from a read` };
        return setAsideStatement(deps.fs, root, id);
      }
      if (MemoryAction.FLOW === action) {
        if (name === undefined) return { error: `${action} ${NEEDS_NAME}` };
        return fetchPlatformFlow(deps.fs, root, name);
      }
      if (MemoryAction.PUSH_FLOW === action) {
        if (name === undefined) return { error: `${action} ${NEEDS_NAME}` };
        const target = safeSessionTarget(deps, sid);
        const saved = await flowsForSession(deps, target).flows.load(name, target.projectId);
        if (!saved.ok)
          return { error: `no saved flow named "${name}" on this machine`, reason: saved.code };
        return pushFlow(deps.fs, root, saved.value, target.projectId);
      }
      if (MemoryAction.ADD === action) {
        const statement = asString(args['statement']);
        if (subject === undefined || statement === undefined || 0 === statement.trim().length)
          return { error: `${action} ${NEEDS_STATEMENT}` };
        return addMemoryStatement(deps.fs, root, { subject, statement });
      }
      const result = await readProjectMemory(deps.fs, root, homedir(), process.env, {
        subject,
        limit: asNumber(args['limit']) ?? DEFAULT_LIMIT,
      });
      if (!result.ok)
        return {
          error: 'no shared memory available for this project',
          reason: result.reason,
          advice: ADVICE[result.reason],
        };
      return { subject: result.subject, known: result.known, total: result.total };
    },
  },
];
