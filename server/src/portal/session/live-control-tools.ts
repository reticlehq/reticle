import { z } from 'zod';
import { noteEmptyRead } from '@/surface/tools/gaps/observed-nothing.js';
import {
  AGENT_ASK_NOTICE,
  AGENT_WAITING_NOTICE,
  PresenterTone,
  SessionState,
  VerdictStatus,
  YIELD_WITHOUT_SESSION_NOTE,
} from '@reticlehq/core';
import { ActionType, ReticleCommand, ReticleTool } from '@reticlehq/core';
import { sessionIdShape } from '@/surface/tools/tool-kit.js';
import { asString } from '@reticlehq/core';
import type { ToolDef } from '@/surface/tools/tool-kit.js';
import { releaseLease } from '@/surface/tools/lease-tools.js';
import type { Session } from './session.js';
import type { SessionManager } from './session-manager.js';
import { gapReportLines } from '@/judgement/runs/artifact/gap-report.js';
import { gapSummary } from '@/judgement/runs/artifact/gap-summary.js';
import {
  RESULT_FIELD,
  claimAgainstGrade,
  endedAgentSession,
  verdictsSettled,
  resultField,
  sessionResult,
} from '@/surface/tools/reticle-result.js';

/** The tab's journal once every verdict in flight has been decided and written. */
async function settledJournal(session: Session) {
  await verdictsSettled();
  await session.flushJournal?.();
  return session.readJournalActions();
}

/**
 * Did the caller name a session that has DEPARTED?
 *
 * `resolve` answers a departed id with its live SUCCESSOR. That is right for everything that
 * observes -- a tab reloads, its id survives in sessionStorage, and an `assert` should keep
 * working -- and wrong for a call that changes a session's state: it acts on a tab the caller never
 * named (#983, #1774). An id the daemon has never seen is not departed; it falls through to
 * `resolve`, which refuses it with the live ids named.
 */
function namedSessionDeparted(sessions: SessionManager, requested: string | undefined): boolean {
  return (
    requested !== undefined &&
    sessions.get(requested) === undefined &&
    sessions.departed(requested) !== undefined
  );
}

/**
 * The session an id-less yield hands back.
 *
 * Yield is non-destructive: it only gives the tab back to the human. With several projects connected,
 * an id-less call hit the same "which session?" refusal a destructive action gets, so an agent that
 * had just finished driving one tab had to look its id up in order to let go of it (#1258). When the
 * ordinary resolution refuses, the one connected session this caller has DRIVEN (it holds a
 * remembered act) is the clear candidate. None, or more than one, and the refusal stands: guessing
 * which of two driven tabs to release is still a guess.
 */
function resolveYieldTarget(sessions: SessionManager, requested: string | undefined): Session {
  if (requested !== undefined) return sessions.resolve(requested);
  try {
    return sessions.resolve();
  } catch (refusal) {
    // In scope only: a tab the project scope refuses to hand over is not this caller's to release.
    const driven = sessions.inScope().filter((s) => s.lastAct.cursor() !== undefined);
    const [only] = driven;
    if (1 !== driven.length || only === undefined) throw refusal;
    only.markAgentActivity();
    return only;
  }
}

/**
 * Is this a turn ending with nothing attached, rather than a call about a specific tab?
 *
 * Only true when the caller named NO session and none is connected. Ending a turn is a statement
 * about the agent, not about a tab, so it must not fail merely because no app was ever wired — that
 * made a call documented as MANDATORY fail in the most common state a daemon is in, and the agents
 * that hit it stopped calling it and wrote the gap into prose instead.
 *
 * Naming a session that does not exist stays an error. That is a mistake about WHICH tab you are
 * talking to, and swallowing it would hide a real one.
 */
function endingTurnWithNothingAttached(deps: { sessions: { count(): number } }, id?: string) {
  return id === undefined && 0 === deps.sessions.count();
}

/**
 * Live-control agent tools: the agent's side of the human-in-the-loop control surface.
 *
 * - reticle_end_session: terminal stop. Sets state `ended` and syncs the panel (PRESENTER) with an
 * optional summary. Idempotent — ending an already-ended session is a safe no-op.
 * - reticle_resume: clears a human pause. Sets state `active` and syncs the panel.
 * - reticle_messages: explicit poll — drains and returns the queued human notes.
 *
 * State changes go through `setState`, which echoes the state to the panel in a SINGLE PRESENTER
 * push (optionally carrying human-facing text, e.g. the end summary) — a transition never emits two
 * PRESENTER commands. No clock is read here — inbox stamps were assigned by the session's injected
 * elapsed clock at enqueue time.
 */
const DISCONNECT_NEEDS_SESSION_ID =
  '`disconnect: true` needs the `sessionId` of the page to detach — list them with ' +
  'reticle_session{action:"list"}; it is never picked for you, because detaching the wrong window ' +
  'cuts you off from the app.';

/** A resume on a named session that has departed: there is no pause left to clear (#1774). */
function resumeDepartedNote(requested: string): string {
  return (
    `session '${requested}' had already disconnected, so there was no pause to clear. ` +
    'Nothing else was resumed: a named session is matched exactly, never substituted.'
  );
}

/**
 * A review on a named session that has departed. Marks belong to one tab, so a listing from another
 * tab answers a question the caller did not ask.
 */
function reviewDepartedError(requested: string): string {
  return (
    `session '${requested}' had already disconnected, so its marks are gone. ` +
    'No other session was read: a named session is matched exactly, never substituted. ' +
    'List the live sessions with reticle_session{action:"list"}.'
  );
}

/** The agent's claim, when it is one of the words a run verdict uses. */
function claimOf(value: unknown): VerdictStatus | undefined {
  const claims: readonly unknown[] = [
    VerdictStatus.PASS,
    VerdictStatus.FAIL,
    VerdictStatus.PARTIAL,
  ];
  return claims.includes(value) ? (value as VerdictStatus) : undefined;
}

/*
 * `reticle_board`: named values that every session and every agent on this bridge can read and
 * write. A desktop session reads a number in Calculator, a browser session puts it in a form, and
 * a second agent, or a plan of the Harness that runs in another process, reads it here. The board
 * lives as long as the bridge; it is not saved.
 */
/** The most keys on a board, and the longest value. A value past it is refused, never cut. */
export const BOARD_MAX_KEYS = 200;
export const BOARD_MAX_VALUE = 4000;

interface Entry {
  value: string;
  /** The session that wrote it, when the writer named one. */
  from?: string;
  at: number;
}

/** One board for each bridge: the session manager of the bridge is its key. */
const boards = new WeakMap<object, Map<string, Entry>>();
function boardOf(owner: object): Map<string, Entry> {
  let board = boards.get(owner);
  if (board === undefined) {
    board = new Map();
    boards.set(owner, board);
  }
  return board;
}

const EntrySchema = z.object({
  key: z.string(),
  value: z.string(),
  from: z.string().optional(),
  at: z.number(),
});

/** One end of a carry: an element in a session, by its ref. */
const EndSchema = z.object({ sessionId: z.string().min(1), ref: z.string().min(1) });
type End = z.infer<typeof EndSchema>;

/**
 * What an element of a session shows: its value when it has one, else its name. Read from the
 * snapshot line, the one format that the browser and the computer both write.
 */
async function shownBy(
  deps: Parameters<ToolDef['handler']>[0],
  end: End,
): Promise<string | undefined> {
  const answer = await deps.sessions.resolve(end.sessionId).command(ReticleCommand.SNAPSHOT, {});
  const tree = answer.ok ? (answer.result as { tree?: unknown } | undefined)?.tree : undefined;
  const line = ('string' === typeof tree ? tree : '')
    .split('\n')
    .find((one) => one.includes(`(ref=${end.ref})`));
  if (line === undefined) {
    return undefined;
  }
  const unquote = (text: string): string =>
    text.replace(/\\(["\\n])/g, (_, c: string) => ('n' === c ? '\n' : c));
  const value = /\[value="((?:\\.|[^"\\])*)"\]/.exec(line)?.[1];
  if (value !== undefined) {
    return unquote(value);
  }
  // A field with no value is empty: its name is its label, not what it holds.
  if (/^\s*- (textbox|searchbox|combobox|spinbutton)\b/.test(line)) {
    return '';
  }
  return unquote(/^\s*- [^"(]*"((?:\\.|[^"\\])*)"/.exec(line)?.[1] ?? '');
}

/**
 * A carry: the value of an element in one session, written into an element of another, and read
 * back from it. The agent copies nothing by hand, and the answer says whether the value arrived.
 */
async function carry(
  deps: Parameters<ToolDef['handler']>[0],
  board: Map<string, Entry>,
  key: string,
  from: End,
  to: End,
): Promise<Record<string, unknown>> {
  const value = await shownBy(deps, from);
  if (value === undefined) {
    return {
      ok: false,
      error: `ref ${from.ref} is not in session ${from.sessionId}. Look at that session again for the ref of the value.`,
    };
  }
  const entry: Entry = { value, at: deps.now(), from: from.sessionId };
  board.set(key, entry);
  // Inside an attribution window, as every action is: what the fill changes is the action's
  // effect, and the settle check must not learn it as background change.
  const target = deps.sessions.resolve(to.sessionId);
  target.beginAction(ReticleTool.BOARD, { ref: to.ref });
  let acted;
  try {
    acted = await target.command(ReticleCommand.ACT, {
      ref: to.ref,
      action: ActionType.FILL,
      args: { value },
    });
  } finally {
    target.finishAction();
  }
  const shows = await shownBy(deps, to);
  const arrived = acted.ok && shows === value;
  return {
    ok: true,
    entries: [{ key, ...entry }],
    carried: value,
    arrived,
    ...(arrived ? {} : { shows: shows ?? '', ...(acted.ok ? {} : { error: acted.error }) }),
  };
}

export const BOARD_TOOL: ToolDef = {
  name: ReticleTool.BOARD,
  description:
    'Named values that every session and agent on this bridge shares. { key, value } writes; { key } reads one; {} reads all. Use it to pass a value from one realm to another: read it in a desktop application, write it here, read it in a browser session or another agent. Give sessionId to say which session wrote it.',
  inputSchema: {
    key: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('The name of the value. With no value: read it. Absent: read every value.'),
    value: z
      .string()
      .optional()
      .describe('The value to keep under the key, at most 4000 characters. Absent: read.'),
    sessionId: z.string().optional().describe('The session that writes the value, kept with it.'),
    carry: z
      .object({ from: EndSchema, to: EndSchema })
      .optional()
      .describe(
        'Carry a value from an element of one session into an element of another: { from: { sessionId, ref }, to: { sessionId, ref } }, with a key. The value is read from the element, kept under the key, filled into the target, and read back: `arrived` says whether the target shows it.',
      ),
  },
  outputSchema: {
    ok: z.boolean(),
    entries: z.array(EntrySchema).optional(),
    error: z.string().optional(),
    carried: z.string().optional(),
    arrived: z.boolean().optional(),
    shows: z.string().optional(),
  },
  handler: (deps, args) => {
    const board = boardOf(deps.sessions);
    const key = asString(args['key']);
    const value = asString(args['value']);
    const from = asString(args['sessionId']);
    const carried = z.object({ from: EndSchema, to: EndSchema }).safeParse(args['carry']);
    if (args['carry'] !== undefined) {
      if (key === undefined || !carried.success) {
        return Promise.resolve({
          ok: false,
          error: 'a carry needs a key and { from: { sessionId, ref }, to: { sessionId, ref } }',
        });
      }
      return carry(deps, board, key, carried.data.from, carried.data.to);
    }
    if (value !== undefined) {
      if (key === undefined) {
        return Promise.resolve({ ok: false, error: 'a value needs a key: { key, value }' });
      }
      if (value.length > BOARD_MAX_VALUE) {
        return Promise.resolve({
          ok: false,
          error: `the value has ${String(value.length)} characters; the board keeps at most ${String(BOARD_MAX_VALUE)}. Write a shorter value, or a path to a file that holds it.`,
        });
      }
      if (!board.has(key) && board.size >= BOARD_MAX_KEYS) {
        return Promise.resolve({
          ok: false,
          error: `the board has ${String(BOARD_MAX_KEYS)} keys, the most it keeps. Write to a key that is there.`,
        });
      }
      const entry: Entry = { value, at: deps.now(), ...(from === undefined ? {} : { from }) };
      board.set(key, entry);
      return Promise.resolve({ ok: true, entries: [{ key, ...entry }] });
    }
    const all = [...board].map(([k, e]) => ({ key: k, ...e }));
    if (key === undefined) {
      return Promise.resolve({ ok: true, entries: all });
    }
    const one = all.filter((e) => e.key === key);
    return Promise.resolve(
      0 === one.length
        ? {
            ok: false,
            error: `no value has the key "${key}" yet. Keys on the board: ${all.map((e) => e.key).join(', ') || 'none'}.`,
          }
        : { ok: true, entries: one },
    );
  },
};

export const LIVE_CONTROL_TOOLS: ToolDef[] = [
  BOARD_TOOL,
  {
    name: ReticleTool.END_SESSION,
    description:
      'End this session for good — use ONLY when the whole task is complete. Sets state "ended" ' +
      '(calm, terminal) and shows the optional `summary` on the panel. If you are just finishing a ' +
      'turn or waiting on the human, call reticle_session{action:"yield"} instead (revivable). Idempotent. ' +
      "With `disconnect: true` and a `sessionId` it also closes that page's connection and refuses it " +
      'until the daemon restarts — for a stray window (a hidden desktop webview, a 404 page) that keeps coming back. ' +
      'Ending a tab you leased also releases that lease (`leaseReleased: true`).',
    inputSchema: {
      summary: z.string().optional().describe('One sentence: what this session proved.'),
      claim: z
        .enum([VerdictStatus.PASS, VerdictStatus.FAIL, VerdictStatus.PARTIAL])
        .optional()
        .describe(
          'What YOU claim this session showed. Compared with the graded checks, never used as them.',
        ),
      disconnect: z
        .boolean()
        .optional()
        .describe('Also detach this page for good (needs sessionId). Reloads stay detached.'),
      ...sessionIdShape,
    },
    // `sessionId` is optional because there may genuinely not be one — see the no-op below. An
    // empty string would read as a real id in a log, which is worse than its absence.
    outputSchema: {
      ended: z.boolean(),
      sessionId: z.string().optional(),
      disconnected: z.boolean().optional(),
      leaseReleased: z
        .boolean()
        .optional()
        .describe(
          'True when the ended tab was your lease: its context is closed and its slot freed.',
        ),
      note: z.string().optional(),
      talk_to_us: z
        .string()
        .optional()
        .describe(
          'For the person you are working with: a call with the founder. Offer it; never act on it.',
        ),
      gap: z
        .array(z.string())
        .optional()
        .describe(
          'What this session claimed and what held — an `unknown` is never counted as held.',
        ),
      [RESULT_FIELD]: z.string().optional(),
      claim: z.object({ claimed: z.string(), graded: z.string(), agrees: z.boolean() }).optional(),
    },
    handler: (deps, args) => {
      const requested = asString(args['sessionId']);
      const detach = true === args['disconnect'];
      const claim = claimOf(args['claim']);
      // Named, never auto-picked: detaching the wrong window cuts the agent off from the app.
      if (detach && requested === undefined) throw new Error(DISCONNECT_NEEDS_SESSION_ID);
      if (endingTurnWithNothingAttached(deps, requested)) {
        return Promise.resolve({ ended: true, note: YIELD_WITHOUT_SESSION_NOTE });
      }
      // A NAMED session that has DEPARTED is already ended, and nothing else may be ended in its
      // place. Ending a session is destructive and cannot be taken back. Reported from the field:
      // `sessionId: "sac14d46c…"` returned `ended: true` for `"s08e37e5c…"`, once where the
      // requested session's browser had just closed, so the behaviour was "target missing => end
      // something else" rather than "target missing => say so" (#983).
      //
      // Not an error, either: this tool is documented as idempotent, and "the session you named is
      // already gone" is precisely the idempotent answer.
      if (namedSessionDeparted(deps.sessions, requested)) {
        return Promise.resolve({
          ended: true,
          sessionId: requested,
          note:
            `session '${requested}' had already disconnected, so there was nothing to end. ` +
            'Nothing else was ended: a named session is matched exactly, never substituted.',
        });
      }
      // Resolved synchronously, as before: a named session that does not exist still throws here
      // rather than becoming a rejected promise the caller did not expect.
      const session = deps.sessions.resolve(requested);
      const summary = asString(args['summary']);
      // A verdict still being decided (an assert waiting out its budget) is one of this session's
      // checks: decided and journaled before the session's result is folded, never after it.
      return settledJournal(session).then(async (all) => {
        // This agent session only: its own calls since its last end, never the Harness drives the
        // tab also holds, and under its own run id so a later end does not overwrite this run.
        const ended = endedAgentSession(session.id, all, session.elapsed?.(), claim);
        const actions = ended.actions;
        // The moment the agent calls the task complete is when "and what did not hold" is worth a
        // line: the same fold `reticle_context` and `reticle report` serve, so they cannot disagree.
        const gap = gapReportLines(gapSummary(actions));
        const panel = [summary, gap[0]].filter((line): line is string => line !== undefined);
        // One PRESENTER push for the transition; the summary and the gap headline ride together.
        session.setState(SessionState.ENDED, 0 === panel.length ? undefined : panel.join('\n'));
        if (detach) deps.sessions.park(session);
        const answer = {
          ended: true,
          sessionId: session.id,
          ...(detach ? { disconnected: true } : {}),
          gap,
          // No founder's-call invite here: it is offered to someone stuck (an error, an empty
          // session list), never at the end of every task.
          ...(claim === undefined ? {} : { claim: claimAgainstGrade(claim, actions) }),
          ...resultField(() => sessionResult(deps, session.id, actions, ended.wallMs, ended.runId)),
        };
        // An ended lease left connected kept the tab registered until the reaper took it, so the
        // next agent's every id-less call was refused as ambiguous. Released after the answer is
        // folded, because releasing closes the tab. Only this caller's own lease, never another's.
        const pool = deps.pool;
        if (pool === undefined || !pool.heldBy(session.id, deps.attachId)) return answer;
        await releaseLease(deps, pool, session.id);
        return { ...answer, leaseReleased: true };
      });
    },
  },
  {
    name: ReticleTool.YIELD,
    description:
      'MANDATORY before you stop driving and hand control back to the human — call this whenever you ' +
      'finish a turn or need to wait on them, so the panel never falsely shows the agent as live. ' +
      'mode:"waiting" = you are done responding and will continue on their next message. ' +
      'mode:"ask" = you are blocked and need an answer first; put the question in `note` so it shows ' +
      'on the panel. The session is REVIVED automatically on your next tool call, so you never need to ' +
      'reopen it. Use reticle_session{action:"end"} instead only when the whole task is truly complete.',
    inputSchema: {
      mode: z
        .enum([PresenterTone.WAITING, PresenterTone.ASK])
        .describe('"waiting" = turn done, will resume; "ask" = blocked, need the human to answer.'),
      note: z
        .string()
        .optional()
        .describe('For mode:"ask", the question to show the human on the panel.'),
      ...sessionIdShape,
    },
    outputSchema: {
      yielded: z.boolean(),
      mode: z.string(),
      sessionId: z.string().optional(),
      note: z.string().optional(),
    },
    handler: (deps, args) => {
      const requested = asString(args['sessionId']);
      const ask = asString(args['mode']) === PresenterTone.ASK;
      if (endingTurnWithNothingAttached(deps, requested)) {
        return Promise.resolve({
          yielded: true,
          mode: ask ? PresenterTone.ASK : PresenterTone.WAITING,
          note: YIELD_WITHOUT_SESSION_NOTE,
        });
      }
      // A NAMED session that has DEPARTED has nothing to hand back, and no other tab may be marked
      // as waiting in its place (#1774). The same idempotent answer `end` gives.
      if (namedSessionDeparted(deps.sessions, requested)) {
        return Promise.resolve({
          yielded: true,
          mode: ask ? PresenterTone.ASK : PresenterTone.WAITING,
          sessionId: requested,
          note:
            `session '${String(requested)}' had already disconnected, so there was nothing to yield. ` +
            'Nothing else was yielded: a named session is matched exactly, never substituted.',
        });
      }
      const session = resolveYieldTarget(deps.sessions, requested);
      const note = asString(args['note']);
      const tone = ask ? PresenterTone.ASK : PresenterTone.WAITING;
      const text =
        ask && note !== undefined && note.trim().length > 0
          ? `${AGENT_ASK_NOTICE}: ${note.trim()}`
          : ask
            ? AGENT_ASK_NOTICE
            : AGENT_WAITING_NOTICE;
      // autoEnd = revivable end: the panel reflects the handoff now, the agent's next call revives it.
      session.autoEnd(text, tone);
      return Promise.resolve({
        yielded: true,
        mode: ask ? PresenterTone.ASK : PresenterTone.WAITING,
        sessionId: session.id,
      });
    },
  },
  {
    name: ReticleTool.RESUME,
    description:
      'Clear a human pause and resume driving the page. Sets state "active" and syncs the panel ' +
      '(PRESENTER). Call after you have addressed the human guidance returned by a paused reticle_act.',
    inputSchema: { ...sessionIdShape },
    outputSchema: { ok: z.boolean(), note: z.string().optional() },
    handler: (deps, args) => {
      const requested = asString(args['sessionId']);
      // A NAMED session that has DEPARTED has no pause to clear. Resuming its successor would clear a
      // pause the human set by hand on a tab the agent never named (#1774). Idempotent, as `end` is.
      if (namedSessionDeparted(deps.sessions, requested)) {
        return Promise.resolve({ ok: true, note: resumeDepartedNote(String(requested)) });
      }
      const session = deps.sessions.resolve(requested);
      // setState echoes ACTIVE to the panel in a single PRESENTER push.
      session.setState(SessionState.ACTIVE);
      return Promise.resolve({ ok: true });
    },
  },
  {
    name: ReticleTool.MESSAGES,
    description:
      'Drain and return any messages the human queued from the panel since the last poll. Use to ' +
      'explicitly check for human guidance without acting.',
    inputSchema: { ...sessionIdShape },
    outputSchema: {
      messages: z.array(z.unknown()),
      delivered: z
        .array(z.unknown())
        .optional()
        .describe(
          'Present ONLY when this poll found nothing new but the human HAS spoken this session: everything they said, including what was already handed to you inline on an earlier tool result. An empty `messages` never means silence.',
        ),
    },
    handler: (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const messages = session.drainInbox();
      if (messages.length > 0) return Promise.resolve({ messages });
      // Nothing NEW is not the same as nothing said. The inbox has two consumers — this poll and the
      // control envelope spliced onto every tool result — and delivery is destructive, so a message
      // handed over inline moments ago left this call reporting an empty queue with a note that read
      // as "the human has said nothing". Reported from the field, from both ends: the agent believed
      // it, and the person who typed the message got silence with no sign it had been seen.
      const history = session.inboxHistory();
      if (history.length > 0) {
        return Promise.resolve({
          messages,
          delivered: [...history],
          note:
            `nothing NEW since your last poll — but the human has sent ` +
            `${String(history.length)} message(s) this session, listed in \`delivered\`. They were ` +
            `handed to you inline on an earlier tool result, which is why this queue is empty. An ` +
            `empty \`messages\` never means the human has said nothing.`,
        });
      }
      // An empty inbox and a panel that is not wired both return `[]`. The first means the human has
      // said nothing; the second means an agent is waiting on a channel that does not exist.
      return Promise.resolve(
        noteEmptyRead({ messages }, 'messages', {
          noun: 'messages from the human since the last poll',
          // The HUD's note box is the one producer, and every tool result already carries what it
          // sends, so polling this is rarely needed and silence here is only silence so far.
          caveat:
            'notes from the HUD also arrive inline on any Reticle tool result (`control.guidance`), ' +
            'so an empty queue means nothing new since the last call, not that the human agrees',
        }),
      );
    },
  },
  {
    name: ReticleTool.REVIEW,
    description:
      'List the mistakes the human pinned to elements on the running page (the "annotate the bug ' +
      'where you see it" loop), then resolve each once you have fixed it. Each pending mark carries ' +
      'the human note, the element label, and — when the framework stamped it — the source file:line ' +
      'to open, plus a ready-to-act `fix` hint. After applying a fix, call again with ' +
      '`{ resolve: "<id>" }` to retire that mark. Reading does NOT consume a mark, so you can list, ' +
      'fix, verify, then resolve.',
    inputSchema: {
      resolve: z
        .string()
        .optional()
        .describe('A mark id (e.g. "m1") to retire after you have fixed it. Omit to just list.'),
      all: z
        .boolean()
        .optional()
        .describe('Include already-resolved marks in the listing (default: pending only).'),
      ...sessionIdShape,
    },
    outputSchema: {
      marks: z.array(z.unknown()),
      pendingCount: z.number(),
      resolved: z.boolean().optional(),
      resolvedNote: z
        .string()
        .optional()
        .describe(
          'The note on the mark that was actually retired. CHECK IT against the mark you meant to resolve: a bare `resolved:true` cannot tell you it closed the right one, and ids are only meaningful while the session that issued them lives.',
        ),
    },
    handler: (deps, args) => {
      const requested = asString(args['sessionId']);
      // A NAMED session that has DEPARTED is refused, not substituted: a listing or a `resolve` on its
      // successor reads or retires marks on a tab the caller never named (#1774).
      if (namedSessionDeparted(deps.sessions, requested)) {
        throw new Error(reviewDepartedError(String(requested)));
      }
      const session = deps.sessions.resolve(requested);
      const resolveId = asString(args['resolve']);
      let resolved: boolean | undefined;
      let resolvedNote: string | undefined;
      if (resolveId !== undefined) {
        // Grab the note BEFORE retiring it so we can close the loop visually for the human.
        const mark = session.allMarks().find((m) => m.id === resolveId);
        resolved = session.resolveMark(resolveId);
        if (resolved && mark !== undefined) {
          // Echoed back to the CALLER too, not only to the panel. A bare `resolved:true` is equally
          // consistent with "I retired the bug you fixed" and "I retired somebody else's", and an
          // agent hit exactly that — it closed a mark the human had recorded minutes later while
          // the two it had actually fixed vanished with no record.
          resolvedNote = mark.note;
          // The human watching the panel sees their flagged bug get marked fixed (fire-and-forget).
          session.pushNarration(`✓ fixed: ${mark.note}`);
        }
      }
      const source = true === args['all'] ? session.allMarks() : session.pendingMarks();
      const marks = source.map((m) => ({ ...m, fix: buildFixHint(m) }));
      const out: {
        marks: typeof marks;
        pendingCount: number;
        resolved?: boolean;
        resolvedNote?: string;
      } = {
        marks,
        pendingCount: session.pendingMarkCount(),
      };
      if (resolved !== undefined) out.resolved = resolved;
      if (resolvedNote !== undefined) out.resolvedNote = resolvedNote;
      return Promise.resolve(out);
    },
  },
];

/**
 * The single actionable next-move for a pending mark: point the agent at the source (or the element
 * label when no file:line was stamped), echo the human's note, and name the resolve call. Keeping
 * the recovery hint here means the agent is never left guessing what to do with a mark.
 */
function buildFixHint(m: {
  id: string;
  note: string;
  label?: string;
  source?: { file: string; line: number };
}): string {
  const where =
    m.source !== undefined
      ? `Open ${m.source.file}:${String(m.source.line)}`
      : m.label !== undefined
        ? `Find the "${m.label}" element`
        : 'Find the flagged element';
  return `${where} and fix: ${m.note}. Then call reticle_session { action: "review", resolve: "${m.id}" }.`;
}
