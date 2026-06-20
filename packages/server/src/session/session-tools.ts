import { z } from 'zod';
import { IrisCommand } from '@syrin/iris-protocol';
import { IrisTool } from '../tools/tool-names.js';
import { asNumber, asString } from '../tools/tools-helpers.js';
import type { ToolDef, ToolDeps } from '../tools/tools.js';

/**
 * Session lifecycle controls. The presenter session begins on the agent's first action and ends
 * either when the agent ends it (iris_end_session) or after an idle window — and the human keeps the
 * panel (with Copy/Export of the run) afterwards. iris_session lets the AGENT tune that idle window
 * for the app: raise it for a slow app, lower it for a quick check.
 */
export const SESSION_TOOLS: ToolDef[] = [
  {
    name: IrisTool.SESSION,
    description:
      'Tune the presenter session for this app. { idleEndMs } sets how long the session stays open after you go quiet before the panel shows the human you are WAITING (your turn). Default 8s — short so the human is never left thinking the agent is live when it has actually stopped; the floating panel is kept either way. Raise it for a slow app where long gaps between your tool calls are normal. Enforced SERVER-SIDE (immune to background-tab throttling); it also fires if you (the MCP client) disconnect — so a forgotten or crashed session never leaves the HUD reading "live". Going quiet then acting again revives the session automatically. Prefer signalling explicitly with iris_yield; this only tunes the safety net. Returns { applied, idleEndMs }.',
    inputSchema: {
      idleEndMs: z
        .number()
        .optional()
        .describe(
          'Idle window in milliseconds after which the panel shows WAITING (your turn). Default: 8000 (8s). Raise for slow apps.',
        ),
      sessionId: z
        .string()
        .optional()
        .describe(
          'Active session ID from iris_sessions. Omit when only one browser session is open.',
        ),
    },
    outputSchema: {
      applied: z.boolean(),
      idleEndMs: z.number().optional(),
    },
    handler: async (deps: ToolDeps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const idleEndMs = asNumber(args['idleEndMs']);
      // Tune BOTH sides: the browser's foreground idle timer AND the server reaper (the throttle-proof
      // authority), so the agent-set window is honored even when the tab is backgrounded.
      if (idleEndMs !== undefined) session.setIdleEndMs(idleEndMs);
      const res = await session.command(
        IrisCommand.SESSION_CONFIG,
        idleEndMs !== undefined ? { idleEndMs } : {},
      );
      if (!res.ok) throw new Error(res.error ?? 'session config failed');
      return res.result ?? { applied: true };
    },
  },
];
