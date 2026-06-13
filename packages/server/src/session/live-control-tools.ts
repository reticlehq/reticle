import { z } from 'zod';
import { SessionState } from '@syrin/iris-protocol';
import { IrisTool } from '../tools/tool-names.js';
import { asString } from '../tools/tools-helpers.js';
import type { ToolDef } from '../tools/tools.js';

const sessionIdShape = { sessionId: z.string().optional() };

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
    handler: (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      // One PRESENTER push for the transition; the optional summary rides the same push.
      session.setState(SessionState.ENDED, asString(args['summary']));
      return Promise.resolve({ ok: true, state: SessionState.ENDED });
    },
  },
  {
    name: IrisTool.RESUME,
    description:
      'Clear a human pause and resume driving the page. Sets state "active" and syncs the panel ' +
      '(PRESENTER). Call after you have addressed the human guidance returned by a paused iris_act.',
    inputSchema: { ...sessionIdShape },
    handler: (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      // setState echoes ACTIVE to the panel in a single PRESENTER push.
      session.setState(SessionState.ACTIVE);
      return Promise.resolve({ state: SessionState.ACTIVE });
    },
  },
  {
    name: IrisTool.MESSAGES,
    description:
      'Drain and return any messages the human queued from the panel since the last poll. Use to ' +
      'explicitly check for human guidance without acting.',
    inputSchema: { ...sessionIdShape },
    handler: (deps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      return Promise.resolve({ messages: session.drainInbox() });
    },
  },
];
