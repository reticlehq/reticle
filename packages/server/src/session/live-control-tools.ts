import { z } from 'zod';
import { SessionState } from '@syrin/iris-protocol';
import { IrisTool } from '../tools/tool-names.js';
import { asNumber, asString } from '../tools/tools-helpers.js';
import { waitForReady } from './session-readiness.js';
import { recoveryFor } from '../tools/error-recovery.js';
import type { ToolDef } from '../tools/tools.js';

/** Default + ceiling for the readiness wait — keep it short so a truly-missing app fails fast. */
const WAIT_READY_DEFAULT_MS = 5000;
const WAIT_READY_MAX_MS = 30000;

const sessionIdShape = {
  sessionId: z
    .string()
    .optional()
    .describe('Active session ID from iris_sessions. Omit when only one browser session is open.'),
};

/**
 * Live-control agent tools: the agent's side of the human-in-the-loop control surface.
 *
 * - iris_end_session: terminal stop. Sets state `ended` and syncs the panel (PRESENTER) with an
 *   optional summary. Idempotent — ending an already-ended session is a safe no-op.
 * - iris_resume: clears a human pause. Sets state `active` and syncs the panel.
 * - iris_messages: explicit poll — drains and returns the queued human notes.
 *
 * State changes go through `setState`, which echoes the state to the panel in a SINGLE PRESENTER
 * push (optionally carrying human-facing text, e.g. the end summary) — a transition never emits two
 * PRESENTER commands. No clock is read here — inbox stamps were assigned by the session's injected
 * elapsed clock at enqueue time.
 */
export const LIVE_CONTROL_TOOLS: ToolDef[] = [
  {
    name: IrisTool.END_SESSION,
    description:
      'End this live testing session. Sets the server state to "ended", tells the human panel ' +
      '(PRESENTER), and stops driving. Optional `summary` is shown in the panel. Idempotent.',
    inputSchema: { summary: z.string().optional(), ...sessionIdShape },
    outputSchema: { ended: z.boolean(), sessionId: z.string() },
    handler: (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      // One PRESENTER push for the transition; the optional summary rides the same push.
      session.setState(SessionState.ENDED, asString(args['summary']));
      return Promise.resolve({ ended: true, sessionId: session.id });
    },
  },
  {
    name: IrisTool.RESUME,
    description:
      'Clear a human pause and resume driving the page. Sets state "active" and syncs the panel ' +
      '(PRESENTER). Call after you have addressed the human guidance returned by a paused iris_act.',
    inputSchema: { ...sessionIdShape },
    outputSchema: { ok: z.boolean() },
    handler: (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      // setState echoes ACTIVE to the panel in a single PRESENTER push.
      session.setState(SessionState.ACTIVE);
      return Promise.resolve({ ok: true });
    },
  },
  {
    name: IrisTool.MESSAGES,
    description:
      'Drain and return any messages the human queued from the panel since the last poll. Use to ' +
      'explicitly check for human guidance without acting.',
    inputSchema: { ...sessionIdShape },
    outputSchema: { messages: z.array(z.unknown()) },
    handler: (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      return Promise.resolve({ messages: session.drainInbox() });
    },
  },
  {
    name: IrisTool.REVIEW,
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
    },
    handler: (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const resolveId = asString(args['resolve']);
      let resolved: boolean | undefined;
      if (resolveId !== undefined) {
        // Grab the note BEFORE retiring it so we can close the loop visually for the human.
        const mark = session.allMarks().find((m) => m.id === resolveId);
        resolved = session.resolveMark(resolveId);
        if (resolved && mark !== undefined) {
          // The human watching the panel sees their flagged bug get marked fixed (fire-and-forget).
          session.pushNarration(`✓ fixed: ${mark.note}`);
        }
      }
      const source = args['all'] === true ? session.allMarks() : session.pendingMarks();
      const marks = source.map((m) => ({ ...m, fix: buildFixHint(m) }));
      const out: { marks: typeof marks; pendingCount: number; resolved?: boolean } = {
        marks,
        pendingCount: session.pendingMarkCount(),
      };
      if (resolved !== undefined) out.resolved = resolved;
      return Promise.resolve(out);
    },
  },
  {
    name: IrisTool.WAIT_READY,
    description:
      'Block until the app is connected, then continue — call this once right after init so your ' +
      'first real tool call does not lose the race with the SDK connecting its WebSocket. Returns as ' +
      'soon as a session exists (no latency if one already does), or after `timeoutMs` with a ' +
      'recovery hint if none appears.',
    inputSchema: {
      timeoutMs: z
        .number()
        .optional()
        .describe('How long to wait for a session (ms). Default 5000, max 30000.'),
    },
    outputSchema: {
      ready: z.boolean(),
      sessionCount: z.number(),
      recovery: z.string().optional(),
    },
    handler: async (deps, args) => {
      const requested = asNumber(args['timeoutMs']) ?? WAIT_READY_DEFAULT_MS;
      const timeoutMs = Math.max(0, Math.min(requested, WAIT_READY_MAX_MS));
      const ready = await waitForReady({
        count: () => deps.sessions.count(),
        timeoutMs,
        now: deps.now,
        sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
      });
      if (ready) return { ready: true, sessionCount: deps.sessions.count() };
      const recovery = recoveryFor('no browser session connected');
      return recovery !== undefined
        ? { ready: false, sessionCount: 0, recovery }
        : { ready: false, sessionCount: 0 };
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
  return `${where} and fix: ${m.note}. Then call iris_review { resolve: "${m.id}" }.`;
}
