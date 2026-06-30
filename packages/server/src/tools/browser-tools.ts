import { z } from 'zod';
import { ReticleCommand } from '@reticle/protocol';
import { ReticleTool } from './tool-names.js';
import { asString } from './tools-helpers.js';
import { sessionIdShape, commandOrThrow } from './tool-kit.js';
import type { ToolDef } from './tools.js';

export const BROWSER_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.NAVIGATE,
    description:
      'Navigate the connected browser tab to a URL. The SDK reconnects automatically after the page loads. Use reticle_sessions to confirm the new tab is connected before acting.',
    inputSchema: {
      url: z.string().describe('The URL to navigate to.'),
      ...sessionIdShape,
    },
    outputSchema: {
      ok: z.boolean(),
      url: z.string().optional(),
      reason: z.string().optional(),
    },
    handler: async (deps, args) => {
      const url = asString(args['url']);
      if (url === undefined || url.length === 0) return { ok: false, reason: 'url required' };
      const result = (await commandOrThrow(
        deps,
        asString(args['sessionId']),
        ReticleCommand.NAVIGATE,
        { url },
      )) as { ok?: unknown; url?: unknown; reason?: unknown };
      return {
        ok: result.ok === true,
        ...(typeof result.url === 'string' ? { url: result.url } : {}),
        ...(typeof result.reason === 'string' ? { reason: result.reason } : {}),
      };
    },
  },
  {
    name: ReticleTool.REFRESH,
    description:
      'Reload the connected browser tab. Pass { hard: true } to bypass the browser cache (equivalent to Cmd+Shift+R). The SDK reconnects automatically after the reload.',
    inputSchema: {
      hard: z
        .boolean()
        .optional()
        .describe('Set true to bypass the browser cache. Default: false (normal reload).'),
      ...sessionIdShape,
    },
    outputSchema: {
      ok: z.boolean(),
    },
    handler: async (deps, args) => {
      await commandOrThrow(deps, asString(args['sessionId']), ReticleCommand.REFRESH, {
        hard: args['hard'] === true,
      });
      return { ok: true };
    },
  },
];
