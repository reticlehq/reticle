import { z } from 'zod';
import { IrisCommand } from '@syrin/iris-protocol';
import { IrisTool } from './tool-names.js';
import { asNumber, asString } from './tools-helpers.js';
import type { ToolDef, ToolDeps } from './tools.js';

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
      'Tune the presenter session for this app. { idleEndMs } sets how long the session stays open after you go quiet before it AUTO-ENDS (page glow off, the floating panel is kept so the human can read + Copy/Export the run). Default 5min. Raise it for slow apps, lower it for quick checks. Returns { applied, idleEndMs }.',
    inputSchema: {
      idleEndMs: z.number().optional(),
      sessionId: z.string().optional(),
    },
    handler: async (deps: ToolDeps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const idleEndMs = asNumber(args['idleEndMs']);
      const res = await session.command(
        IrisCommand.SESSION_CONFIG,
        idleEndMs !== undefined ? { idleEndMs } : {},
      );
      if (!res.ok) throw new Error(res.error ?? 'session config failed');
      return res.result ?? { applied: true };
    },
  },
];
