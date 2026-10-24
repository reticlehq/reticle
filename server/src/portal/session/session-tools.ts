import { z } from 'zod';
import {
  HudCorner,
  HudVisibility,
  HUD_MIN_SDK_VERSION,
  HUD_RELOAD_TO_RESTORE,
  ReticleCommand,
} from '@reticlehq/core';
import { ReticleTool } from '@reticlehq/core';
import { asNumber, asString } from '@reticlehq/core';
import { compareVersions } from '@/command/version/version-skew.js';
import { idleMsSchema } from '@/surface/tools/args/numeric-bounds.js';
import type { ToolDef, ToolDeps } from '@/surface/tools/tool-kit.js';

function sdkPredatesHud(version: string | undefined): boolean {
  if (version === undefined) return true;
  const order = compareVersions(version, HUD_MIN_SDK_VERSION);
  return order === undefined || order < 0;
}

/**
 * Session lifecycle controls. The presenter session begins on the agent's first action and ends
 * either when the agent ends it (reticle_end_session) or after an idle window — and the human keeps the
 * panel (with Copy/Export of the run) afterwards. reticle_session lets the AGENT tune that idle window
 * for the app: raise it for a slow app, lower it for a quick check.
 */
export const SESSION_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.SESSION_TUNE,
    description:
      'Tune the presenter session for this app. { idleEndMs } sets how long the session stays open after you go quiet before the panel shows the human you are WAITING (your turn). Default 5min — the SLOW backstop; signal handback IMMEDIATELY with reticle_session{action:"yield"} instead of waiting for this. Lower it for snappier auto-handback, raise it for a slow app where long gaps between your tool calls are normal. Enforced SERVER-SIDE (immune to background-tab throttling); it also fires if you (the MCP client) disconnect — so a forgotten or crashed session never leaves the HUD reading "live". Going quiet then acting again revives the session automatically. Also moves the HUD out of your way: { hud: "hidden" | "shown" | "removed" } (removed lasts until the page reloads), or a corner to move it to: { hud: "top-left" }. Use it when the HUD covers a control you must test; say so in your report. Returns { applied, idleEndMs, hud }.',
    inputSchema: {
      idleEndMs: idleMsSchema
        .optional()
        .describe(
          'Idle window in milliseconds after which the panel shows WAITING (your turn). Default: 300000 (5 min) — the slow backstop; prefer reticle_session{action:"yield"}. Raise for slow apps.',
        ),
      hud: z
        .enum([
          ...(Object.values(HudVisibility) as [HudVisibility, ...HudVisibility[]]),
          ...Object.values(HudCorner),
        ])
        .optional()
        .describe('Hide, show or remove the HUD, or move it to a corner.'),
      sessionId: z
        .string()
        .optional()
        .describe(
          'Active session ID from reticle_sessions. Omit when only one browser session is open.',
        ),
    },
    outputSchema: {
      applied: z.boolean(),
      idleEndMs: z.number().optional(),
      hud: z.array(z.string()).optional(),
    },
    handler: async (deps: ToolDeps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const idleEndMs = asNumber(args['idleEndMs']);
      // Tune BOTH sides: the browser's foreground idle timer AND the server reaper (the throttle-proof
      // authority), so the agent-set window is honored even when the tab is backgrounded.
      if (idleEndMs !== undefined) session.setIdleEndMs(idleEndMs);
      // One parameter on the wire to the agent, two to the page: a corner moves it, anything else
      // shows, hides or removes it.
      const asked = asString(args['hud']);
      const isCorner = (Object.values(HudCorner) as (string | undefined)[]).includes(asked);
      const hud = isCorner ? undefined : asked;
      const corner = isCorner ? asked : undefined;
      const res = await session.command(ReticleCommand.SESSION_CONFIG, {
        ...(idleEndMs === undefined ? {} : { idleEndMs }),
        ...(hud === undefined ? {} : { hud }),
        ...(corner === undefined ? {} : { corner }),
      });
      if (!res.ok) throw new Error(res.error ?? 'session config failed');
      // Asked to move the HUD and the page says nothing about it: an SDK older than this daemon, or
      // no HUD mounted. Reported, never `applied: true`: an agent told the HUD moved would test a
      // control it is still covering.
      const applied = (res.result as { hud?: unknown } | undefined)?.hud;
      if (hud !== undefined || corner !== undefined) {
        if (Array.isArray(applied) && applied.includes(HUD_RELOAD_TO_RESTORE)) {
          throw new Error(
            `the HUD on session ${session.id} was removed; reload the page to restore it.`,
          );
        }
        if (!Array.isArray(applied)) {
          if (sdkPredatesHud(session.sdkVersion)) {
            const versionText =
              session.sdkVersion !== undefined ? `page SDK ${session.sdkVersion}` : 'the page SDK';
            throw new Error(
              `${versionText} on session ${session.id} predates \`hud\` (needs ${HUD_MIN_SDK_VERSION}+). Update the SDK (npx @reticlehq/server update) or test with the HUD where it is.`,
            );
          }
          throw new Error(
            `the page did not apply \`hud\`: no HUD is mounted on session ${session.id}, so no HUD covers the page. Continue without \`hud\`.`,
          );
        }
      }
      return res.result ?? { applied: true };
    },
  },
];
