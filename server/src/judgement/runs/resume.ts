/**
 * The resume block: what an agent needs back after its context was compacted, in under ~1k tokens.
 *
 * Reticle holds the memory, never the agent. After a compaction the agent's copy of the session is a
 * summary written by a model, and a summary is exactly where "the checkout step failed" becomes
 * "checkout was tested". So this is folded from the daemon's OWN records — the journal on disk, the
 * intent ledger, the declared request, the app notes — and a claim whose latest verdict is not `yes`
 * is listed as failed or not proved, however the agent remembers it.
 *
 * Served two ways from this one fold: `reticle_context { compact: true }` over MCP, and
 * `reticle context --compact` at the terminal (no daemon needed), which a Claude Code SessionStart
 * hook with matcher `compact` prints straight back into the fresh context.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  JournalVerdictEffectSchema,
  ReticleDir,
  Verified,
  type JournalAction,
} from '@reticlehq/core';
import { PromptContextSchema } from '@reticlehq/core/artifacts';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';
import { IntentStore } from '@/memory/intent/intent-store.js';
import { readAppNotes } from '@/surface/tools/agent/app-notes.js';

/** How many claims of each state are named before the rest are counted. Bounds the block. */
const SHOWN = 5;
/** Any one line, capped: the block must stay well under ~1k tokens whatever the journal holds. */
const LINE_MAX = 160;

/** The primer, short form. The full one lives in the agent's rules file (CLAUDE.md / AGENTS.md). */
export const RESUME_PRIMER: readonly string[] = [
  'Only verified:"yes" passes; "unknown" and "no-fault" are neither pass nor fail.',
  'Declare the consequence before acting: reticle_act_and_wait { target, action, until }. Several steps: one reticle_act { steps: [{ target, action, expect }] }, last expect = end state.',
  'Text is exact-case (ignoreCase only when case does not matter); target by testid or role+name. On a failure read expected/observed/nearest first; never weaken a check.',
];

export interface ResumeFacts {
  actions: readonly JournalAction[];
  /** Intents the ledger still owes (statements). */
  openIntents: readonly string[];
  /** The user's request as declared with reticle_intent, if one is current. */
  request?: string | undefined;
  /** The tab this was about, and where it is now. */
  sessionId?: string | undefined;
  route?: string | undefined;
  /** The cursor to observe from. */
  cursor?: number | undefined;
  /** What this app's notes say (hints for targeting; never evidence). */
  notes: readonly string[];
}

function cap(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > LINE_MAX ? `${one.slice(0, LINE_MAX - 1)}…` : one;
}

function listed(label: string, items: readonly string[]): string[] {
  if (0 === items.length) return [];
  const shown = items.slice(-SHOWN).map((item) => `  - ${cap(item)}`);
  const more = items.length - Math.min(items.length, SHOWN);
  return [
    `${label} (${String(items.length)}):`,
    ...(more > 0 ? [`  … ${String(more)} earlier`] : []),
    ...shown,
  ];
}

/** Each claim's LATEST verdict, in the order the claims were first made. */
export function latestVerdicts(
  actions: readonly JournalAction[],
): { claim: string; verified: string; observed?: string }[] {
  const latest = new Map<string, { claim: string; verified: string; observed?: string }>();
  for (const action of actions) {
    const parsed = JournalVerdictEffectSchema.safeParse(action.effect);
    if (!parsed.success) continue;
    const { claim, verified, observed } = parsed.data;
    latest.set(claim, { claim, verified, ...(observed === undefined ? {} : { observed }) });
  }
  return [...latest.values()];
}

/** The resume block, as lines. */
export function resumeLines(facts: ResumeFacts): string[] {
  const verdicts = latestVerdicts(facts.actions);
  const failed = verdicts
    .filter((v) => Verified.NO === v.verified)
    .map((v) => (v.observed === undefined ? v.claim : `${v.claim} — saw: ${v.observed}`));
  const unproved = verdicts
    .filter((v) => Verified.YES !== v.verified && Verified.NO !== v.verified)
    .map((v) => `${v.claim} (${v.verified})`);
  const held = verdicts.filter((v) => Verified.YES === v.verified).map((v) => v.claim);
  const where = [
    facts.sessionId === undefined ? undefined : `tab ${facts.sessionId}`,
    facts.route === undefined ? undefined : `on ${facts.route}`,
    facts.cursor === undefined ? undefined : `cursor ${String(facts.cursor)}`,
  ].filter((p): p is string => p !== undefined);
  return [
    `Reticle resume${0 === where.length ? '' : ` — ${where.join(', ')}`}. This is the daemon's record, not a summary: trust it over your memory.`,
    ...(facts.request === undefined ? [] : [`Asked: ${cap(facts.request)}`]),
    `Claims: ${String(held.length)} proved · ${String(failed.length)} failed · ${String(unproved.length)} not proved.`,
    ...listed('FAILED — not done', failed),
    ...listed('NOT PROVED — not done', unproved),
    ...listed('Proved', held),
    ...listed('Intents still owed', facts.openIntents),
    ...listed('App notes (hints for targeting, never evidence)', facts.notes),
    'Rules:',
    ...RESUME_PRIMER.map((line) => `  - ${line}`),
  ];
}

/** How long a declared request counts as this session's task (matches next-step.ts). */
const REQUEST_FRESH_MS = 6 * 60 * 60 * 1000;

/** The session whose action ledger was written most recently, if any. */
export function newestSessionId(root: string): string | undefined {
  const dir = join(root, ReticleDir.SESSIONS_SUBDIR);
  if (!existsSync(dir)) return undefined;
  let newest: { id: string; at: number } | undefined;
  for (const id of readdirSync(dir)) {
    const ledger = join(dir, id, ReticleDir.JOURNAL_ACTIONS_FILE);
    if (!existsSync(ledger)) continue;
    const at = statSync(ledger).mtimeMs;
    if (newest === undefined || at > newest.at) newest = { id, at };
  }
  return newest?.id;
}

/** The user's request, when one was declared recently enough to be this session's. */
export function recentRequest(root: string, now: number): string | undefined {
  try {
    const parsed = PromptContextSchema.safeParse(
      JSON.parse(readFileSync(join(root, ReticleDir.REQUEST_FILE), 'utf8')),
    );
    if (!parsed.success || parsed.data.request === undefined) return undefined;
    const at = parsed.data.at;
    return at !== undefined && now - at <= REQUEST_FRESH_MS ? parsed.data.request : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Everything the resume block needs, read from disk — no daemon, which is what a SessionStart hook
 * has the moment after a compaction. The caller supplies the journal reader: the MCP tool holds the
 * live journal, the CLI reads the newest session's ledger.
 */
export async function resumeFromDisk(input: {
  root: string;
  now: number;
  fs: ToolDeps['fs'];
  readActions: (sessionId: string) => Promise<readonly JournalAction[]>;
  sessionId?: string | undefined;
  route?: string | undefined;
  cursor?: number | undefined;
}): Promise<string[]> {
  const sessionId = input.sessionId ?? newestSessionId(input.root);
  // Asked even with no session on disk: a caller holding the live journal answers from it.
  const actions = await input.readActions(sessionId ?? '').catch(() => []);
  const open = await new IntentStore(input.fs, input.root, { now: () => input.now })
    .open()
    .catch(() => []);
  return resumeLines({
    actions,
    openIntents: open.map((intent) => intent.statement),
    request: recentRequest(input.root, input.now),
    sessionId,
    route: input.route,
    cursor: input.cursor,
    notes: readAppNotes(input.root),
  });
}
