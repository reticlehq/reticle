import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  StatementSource,
  classifyStatement,
  splitStatements,
  type PromptContext,
} from '@reticlehq/core/artifacts';
import { redactFeedbackText } from '@/telemetry/feedback.js';
import { reticleDirPaths } from '@/memory/project/dir/reticle-dir.js';
import { IntentStore } from './intent-store.js';
import { IntentShardStore } from './intent-shard-store.js';
import { IntentStatus } from './intent-shard.js';
import { ReticleDir, ReticleTool, apiKeyFrom } from '@reticlehq/core';
import { sessionIdShape } from '@/surface/tools/tool-kit.js';
import { PredicateSchema } from '@reticlehq/engine/question/predicate/predicate.js';
import { sessionRoot } from '@/memory/project/session-root.js';
import { asString } from '@reticlehq/core';
import { isActionLabel } from '@reticlehq/core/artifacts';
import type { ToolDef, ToolDeps } from '@/surface/tools/tool-kit.js';

/**
 * Declare what a change was SUPPOSED to make true, while somebody still knows.
 *
 * One tool with three actions rather than three tools, because the surface is capped and because an
 * agent that has to discover three names to use one idea uses none of them.
 *
 * There is deliberately no `discharge` action. A verdict discharges an intent by satisfying its
 * binding, and a discharge an agent has to remember to file would be the same forgetting problem
 * this exists to solve, moved one layer up.
 */

const DECLARE = 'declare';
const LIST = 'list';
const BIND = 'bind';
/* The sharded store's surface. Same tool, because a second tool name is a second thing to discover. */
const INDEX = 'index';
const SUBJECT = 'subject';
const GET = 'get';
const RECORD = 'record';
/** Why a step label is not stored, in words that say what to write instead. */
const STEP_LABEL_REFUSAL =
  'describes a step that was done, not what must be true. State the rule, e.g. "saving the form shows the new row in the list"';
const MIGRATE = 'migrate';

export const INTENT_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.INTENT,
    description:
      'Record what a change is SUPPOSED to make true, as a durable statement ABOUT THE PRODUCT that a teammate who was not here will understand in six months — name the behaviour, not this run or its step number, and never "renders cleanly", which nothing can check. It is SHARED memory: pooled per project and read back by later agents. Capture it while you still know — then verification does not have to re-derive it from the DOM later. { action:"declare", intents:[{ id, statement, surface? }] } takes prose and needs NO predicate: at declare time there is often no route, no ref and no code yet, and a predicate demanded there is just a mechanism. Declare EARLY (as you build) and batch them — one call per feature is the whole budget. { action:"bind", id, binding } attaches the predicate that would prove it once you know how; an intent with no binding is not a failure, it is the most interesting row in the ledger — something meant that nothing can currently prove. { action:"list" } returns what is still open. Pass `request` (what the user asked, verbatim) once per task. Stored in .reticle/intent/, git-checked.',
    example: {
      action: DECLARE,
      intents: [
        { id: 'checkin', statement: 'clicking Send check-in makes the badge read "checked in"' },
      ],
    },
    inputSchema: {
      action: z.enum([DECLARE, LIST, BIND, INDEX, SUBJECT, GET, RECORD, MIGRATE]),
      subject: z
        .string()
        .optional()
        .describe('subject/record: what the intent is ABOUT — the shard it lives in.'),
      statement: z.string().optional().describe('record only: what must be true, in prose.'),
      why: z
        .string()
        .optional()
        .describe('record only: WHY it must be true. The thing somebody says once and forgets.'),
      source: z
        .string()
        .optional()
        .describe('record only: where it came from — a person, a ticket, a conversation.'),
      status: z
        .enum([IntentStatus.PROPOSED, IntentStatus.AGREED, IntentStatus.PROVED, IntentStatus.STALE])
        .optional()
        .describe('record only: how settled it is. Defaults to proposed.'),
      intents: z
        .array(
          z.object({
            id: z.string().min(1),
            statement: z.string().min(1),
            surface: z
              .object({
                route: z.string().optional(),
                flow: z.string().optional(),
                files: z.array(z.string()).optional(),
              })
              .optional(),
          }),
        )
        // Non-empty in the schema too, so the advertised contract says what `declare` enforces.
        .min(1)
        .optional()
        .describe('declare only. Batchable — declare every intent for a feature in one call.'),
      request: z.string().optional().describe("declare: the user's words, verbatim."),
      id: z.string().optional().describe('bind only: which intent the predicate proves.'),
      /*
       * The predicate schema, not `unknown`.
       *
       * The description has always said "in reticle_assert's shape" and the type said "anything",
       * so a client reading the surface to build this call learned the field's name and nothing
       * else — the same degradation the recursive `until` predicate suffered when it was converted
       * without the SDK's own options. This one was not a converter bug: it was declared that way.
       * Caught by `weakest-client-schemas.test.ts`, which is the first thing that ever looked.
       *
       * Accepting the real shape also means a malformed binding is refused at the boundary instead
       * of being written into the ledger and failing later against a verdict it can never satisfy.
       */
      binding: PredicateSchema.optional().describe(
        "bind only: the predicate that would prove it, in reticle_assert's shape.",
      ),
      ...sessionIdShape,
    },
    outputSchema: {
      intents: z
        .array(z.unknown())
        .optional()
        .describe(
          'The intents this call declared, or on `list` everything still open — each { id, statement, state, declaredAt, binding?, surface?, provenBy?, amended? }. `state` is declared (prose only), bound (a predicate exists), or proved (a verdict satisfied it).',
        ),
      bound: z.boolean().optional().describe('bind only: false when the id names no intent.'),
      refused: z
        .array(z.object({ id: z.string(), reason: z.string() }))
        .optional()
        .describe('declare only: statements not stored, and why.'),
      path: z.string().optional().describe('Where the ledger was written.'),
      entries: z
        .array(z.unknown())
        .optional()
        .describe(
          'index only: one line per intent — { id, subject, statement (summarised), status }. The cheap read: enough to decide WHICH subject to open, without loading any of them.',
        ),
      records: z
        .array(z.unknown())
        .optional()
        .describe('subject only: every full record for that subject.'),
      record: z.unknown().optional().describe('get/record: the single full record, or null.'),
      migrated: z
        .number()
        .optional()
        .describe('migrate only: how many flat-file intents were folded into shards.'),
      subjects: z
        .array(z.string())
        .optional()
        .describe('migrate only: which subjects received them.'),
    },
    handler: async (deps: ToolDeps, args) => {
      const root = sessionRoot(deps, asString(args['sessionId']));
      const store = new IntentStore(deps.fs, root, { now: deps.now });
      const shards = new IntentShardStore(deps.fs, root, { now: deps.now });
      const action = asString(args['action']);

      if (INDEX === action) return { entries: (await shards.index()).entries, path: root };
      if (SUBJECT === action)
        return { records: await shards.subject(asString(args['subject']) ?? ''), path: root };
      if (GET === action) return { record: await shards.get(asString(args['id']) ?? '') };
      if (MIGRATE === action) return { ...(await shards.migrate()), path: root };
      if (RECORD === action) {
        const written = await shards.record({
          id: asString(args['id']) ?? '',
          statement: asString(args['statement']) ?? '',
          subject: asString(args['subject']),
          why: asString(args['why']),
          source: asString(args['source']),
          status: asString(args['status']) as IntentStatus | undefined,
          binding: args['binding'],
        });
        return { record: written, path: root };
      }

      if (BIND === action) {
        const id = asString(args['id']) ?? '';
        return { bound: await store.bind(id, args['binding']) };
      }
      if (LIST === action) {
        // One ledger, so one read. This merged two stores while `declare` and `record` wrote two
        // different files; kept past that, it would add back every PROVED intent to a list that
        // promises only what is still open.
        return { intents: await store.open() };
      }
      const raw = args['intents'];
      const request = asString(args['request']);
      if (request !== undefined && 0 < request.trim().length) {
        await recordRequest(deps, root, request, Array.isArray(raw) ? raw : []);
        if (!Array.isArray(raw) || 0 === raw.length) return { request: 'recorded', path: root };
      }
      // Refused, not read as an empty list: `declare` with nothing to declare stored nothing and
      // answered `{ intents: [] }`, which an agent reads as a declaration that worked (#1118).
      if (!Array.isArray(raw) || 0 === raw.length) {
        throw new Error(
          `${ReticleTool.INTENT} declare: \`intents\` must be a non-empty array of { id, statement }, got ${raw === undefined ? 'nothing' : JSON.stringify(raw)} — nothing was stored`,
        );
      }
      const entries = raw as { id: string; statement: string; surface?: never }[];
      const declared = await store.declare(entries);
      // Said, not swallowed: an agent that declared something and finds nothing stored would
      // otherwise conclude the ledger lost it.
      const refused = entries
        .filter((entry) => isActionLabel(entry.statement))
        .map((entry) => ({ id: entry.id, reason: STEP_LABEL_REFUSAL }));
      return { intents: declared, ...(0 === refused.length ? {} : { refused }), path: root };
    },
  },
];

const MAX_REQUEST = 20_000;
const MAX_STATEMENT = 500;
const MAX_STATEMENTS = 100;
const PROJECT_CONFIG = '.reticle.json';

/** Credentials and personal data out, length capped: the same rules feedback reports follow. */
function redactSecrets(text: string, max: number): string {
  return redactFeedbackText(text, max).text;
}

/**
 * Whether the request goes to the platform with the runs that verify it.
 *
 * A LINKED project shares it unless `.reticle.json` says `"shareRequests": false`: the platform
 * reads what each run was for, which is half of what a run means. An unlinked project has nowhere
 * to send it, and `"shareRequests": true` still shares from one that links later.
 */
function sharesRequests(projectDir: string, reticleRoot: string): boolean {
  let setting: unknown;
  try {
    const config: unknown = JSON.parse(readFileSync(join(projectDir, PROJECT_CONFIG), 'utf8'));
    setting = (config as { shareRequests?: unknown } | null)?.shareRequests;
  } catch {
    setting = undefined;
  }
  if (false === setting) return false;
  if (true === setting) return true;
  // Linked by `reticle connect` (cloud.json), or by a key in the environment, the way CI syncs.
  return (
    existsSync(join(reticleRoot, ReticleDir.CLOUD_LINK_FILE)) ||
    apiKeyFrom(process.env) !== undefined
  );
}

/**
 * Keep the user's request, and every statement in it and in the declared intents, classified and
 * attributed, for the runs that verify it. Secrets are redacted before anything is written.
 *
 * Shared with the platform from a linked project unless `.reticle.json` says `"shareRequests": false`.
 */
async function recordRequest(
  deps: ToolDeps,
  root: string,
  request: string,
  declared: readonly unknown[],
): Promise<void> {
  const text = redactSecrets(request, MAX_REQUEST);
  const agentStatements = declared.flatMap((d) => {
    const statement = (d as { statement?: unknown } | null)?.statement;
    return 'string' === typeof statement ? [statement] : [];
  });
  const context: PromptContext = {
    request: text,
    statements: [
      ...splitStatements(text).map((t) => ({ text: t, source: StatementSource.USER })),
      ...agentStatements.map((t) => ({
        text: redactSecrets(t, MAX_STATEMENT),
        source: StatementSource.AGENT,
      })),
    ]
      .slice(0, MAX_STATEMENTS)
      .map((s) => ({
        ...s,
        text: s.text.slice(0, MAX_STATEMENT),
        kind: classifyStatement(s.text),
      })),
    at: deps.now(),
    shared: sharesRequests(dirname(root), root),
  };
  const path = reticleDirPaths(root).request;
  await deps.fs.mkdir(dirname(path));
  await deps.fs.writeFile(path, `${JSON.stringify(context, null, 2)}\n`);
}
