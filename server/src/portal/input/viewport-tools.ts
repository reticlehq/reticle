import { z } from 'zod';
import { CDP_NO_PROVIDER_REASON, CDP_NO_PROVIDER_RECOMMENDATION } from '@reticlehq/core';
import { ReticleTool } from '@reticlehq/core';
import { sessionIdShape } from '../../surface/tools/tool-kit.js';
import {
  MAX_VIEWPORT_PX,
  MIN_VIEWPORT_PX,
  viewportPxSchema,
} from '../../surface/tools/args/numeric-bounds.js';
import { asString } from '@reticlehq/core';
import type { RealInputProvider } from './real-input.js';
import type { ToolDef, ToolDeps } from '../../surface/tools/tools.js';

/** Bounds so a viewport request stays sane (and a typo can't ask for a 1px or 100k-px window). */
const MIN_DIM = MIN_VIEWPORT_PX;
const MAX_DIM = MAX_VIEWPORT_PX;

/** A provider that can set the viewport — narrows the optional capability so callers branch once. */
type ViewportCapable = RealInputProvider & {
  setViewport(sessionUrl: string, size: { width: number; height: number }): Promise<boolean>;
};

function viewportProvider(deps: ToolDeps): ViewportCapable | undefined {
  const p = deps.realInput;
  return p !== undefined && 'function' === typeof p.setViewport
    ? (p as ViewportCapable)
    : undefined;
}

export const VIEWPORT_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.VIEWPORT,
    description:
      'Pin the DRIVEN page (needs `reticle drive`) to a fixed viewport size so a screenshot baseline is ' +
      'reproducible across machines — the missing piece of CI-stable visual regression, alongside ' +
      'reticle_visual_diff `masks` and a frozen clock (reticle_clock). Set it once before reticle_screenshot / ' +
      'reticle_visual_diff. Returns { applied, width, height } or the no-provider recommendation.',
    inputSchema: {
      width: viewportPxSchema.describe('Viewport width in CSS px (e.g. 1280).'),
      height: viewportPxSchema.describe('Viewport height in CSS px (e.g. 800).'),
      ...sessionIdShape,
    },
    outputSchema: {
      applied: z.boolean(),
      width: z.number(),
      height: z.number(),
      ok: z.boolean().optional(),
      reason: z.string().optional(),
      recommendation: z.string().optional(),
    },
    handler: async (deps, args) => {
      const width = clampDim(args['width']);
      const height = clampDim(args['height']);
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const provider = viewportProvider(deps);
      if (provider !== undefined) {
        const applied = await provider.setViewport(session.url, { width, height });
        if (applied) return { applied: true, width, height };
      }
      // A lease is a Playwright-owned page, so the resize was always possible — this tool just had
      // no route to it. Tried after the driven provider, on the same rule reticle_network_mock
      // follows: when both exist, drive is the page the caller means and a lease is the fallback.
      //
      // Without this, `reticle_viewport` refused on every SDK-only install, which is the DEFAULT
      // install. Reported from the field: mobile-only UI — a `lg:hidden` hamburger, a drawer that
      // only mounts under a breakpoint — could not be driven at a desktop viewport at all, and the
      // recommendation printed alongside the refusal asked the reader to install a second browser.
      const leased = await deps.pool?.setViewportLease(session.id, { width, height });
      if (true === leased) return { applied: true, width, height };
      return {
        applied: false,
        width: 0,
        height: 0,
        ok: false,
        reason: CDP_NO_PROVIDER_REASON,
        recommendation: CDP_NO_PROVIDER_RECOMMENDATION,
      };
    },
  },
];

/** Clamp a requested dimension into [MIN_DIM, MAX_DIM]; a missing/NaN value falls back to MIN_DIM. */
function clampDim(value: unknown): number {
  const n = 'number' === typeof value && Number.isFinite(value) ? Math.round(value) : MIN_DIM;
  return Math.max(MIN_DIM, Math.min(n, MAX_DIM));
}
