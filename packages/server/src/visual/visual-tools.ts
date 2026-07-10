import { z } from 'zod';
import { ReticleCommand, VISUAL_NO_PROVIDER_RECOMMENDATION, VisualReason } from '@reticlehq/core';
import { ReticleTool } from '../tools/tool-names.js';
import { asNumber, asRecord, asString } from '../tools/tools-helpers.js';
import { diffPng, type VisualRect } from './visual-diff.js';
import { VisualStore } from './visual-store.js';
import type { ElementBox, RealInputProvider, ScreenshotOpts } from '../input/real-input.js';
import type { ToolDef, ToolDeps } from '../tools/tools.js';

const sessionIdShape = {
  sessionId: z
    .string()
    .optional()
    .describe(
      'Active session ID from reticle_sessions. Omit when only one browser session is open.',
    ),
};
const rectShape = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

/** A provider that can screenshot — narrows the optional capability so callers branch once. */
type ScreenshotCapable = RealInputProvider & {
  screenshot(sessionUrl: string, opts: ScreenshotOpts): Promise<Uint8Array | undefined>;
};

function screenshotProvider(deps: ToolDeps): ScreenshotCapable | undefined {
  const p = deps.realInput;
  return p !== undefined && typeof p.screenshot === 'function'
    ? (p as ScreenshotCapable)
    : undefined;
}

/** The "you need a driven browser" envelope, shared by both visual tools. */
const noProvider = {
  ok: false as const,
  reason: VisualReason.NO_PROVIDER,
  recommendation: VISUAL_NO_PROVIDER_RECOMMENDATION,
};

function asBox(value: unknown): ElementBox | undefined {
  const b = asRecord(asRecord(value)['box']);
  const x = asNumber(b['x']);
  const y = asNumber(b['y']);
  const w = asNumber(b['width']);
  const h = asNumber(b['height']);
  if (x === undefined || y === undefined || w === undefined || h === undefined) return undefined;
  if (w <= 0 || h <= 0) return undefined;
  return { x, y, width: w, height: h };
}

/** Build capture options from args: explicit clip > ref (resolved via INSPECT) > fullPage. */
async function buildOpts(
  deps: ToolDeps,
  sessionId: string | undefined,
  args: Record<string, unknown>,
): Promise<ScreenshotOpts> {
  const clipArg = args['clip'];
  if (clipArg !== undefined) {
    const c = asRecord(clipArg);
    const box = asBox({ box: c });
    if (box !== undefined) return { clip: box };
  }
  const ref = asString(args['ref']);
  if (ref !== undefined) {
    const session = deps.sessions.resolve(sessionId);
    const res = await session.command(ReticleCommand.INSPECT, { ref });
    const box = res.ok ? asBox(res.result) : undefined;
    if (box !== undefined) return { clip: box };
  }
  return args['fullPage'] === true ? { fullPage: true } : {};
}

function rectsFrom(value: unknown): VisualRect[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rects: VisualRect[] = [];
  for (const r of value as unknown[]) {
    const box = asBox({ box: r });
    if (box !== undefined) rects.push(box);
  }
  return rects.length > 0 ? rects : undefined;
}

/**
 * The opt-in pixel layer. Both tools require a DRIVEN browser (reticle drive /
 * RETICLE_CDP_URL) — the always-on SDK ships no screenshotter — and return a structured NO_PROVIDER
 * envelope (with a recommendation) instead of throwing when none is attached. Behavioral checks
 * stay the default; this is the complementary "does it look right" surface, never bundled in.
 */
export const VISUAL_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.SCREENSHOT,
    description:
      'Capture a pixel screenshot of the DRIVEN page (needs `reticle drive`/RETICLE_CDP_URL — the SDK has no screenshotter) and save it as a visual baseline at .reticle/visual/<name>.png. { fullPage } for the whole scroll height, { ref } or { clip:{x,y,width,height} } for one element/region. Returns { saved:true, name, path, bytes } or { ok:false, reason } when no driven browser is attached.',
    inputSchema: {
      name: z
        .string()
        .describe(
          'Baseline name — saved as .reticle/visual/<name>.png. Use the same name in reticle_visual_diff to compare.',
        ),
      fullPage: z
        .boolean()
        .optional()
        .describe('Capture the full scroll height. Default: viewport only.'),
      ref: z
        .string()
        .optional()
        .describe(
          'Element ref to screenshot (scopes to element bounding box). Omit for full page.',
        ),
      clip: rectShape
        .optional()
        .describe('Explicit { x, y, width, height } clip rectangle in page coordinates.'),
      ...sessionIdShape,
    },
    outputSchema: {
      ok: z.boolean(),
      saved: z.boolean().optional(),
      name: z.string().optional(),
      path: z.string().optional(),
      bytes: z.number().optional(),
      reason: z.string().optional(),
      recommendation: z.string().optional(),
    },
    handler: async (deps: ToolDeps, args) => {
      const provider = screenshotProvider(deps);
      if (provider === undefined) return noProvider;
      const sessionId = asString(args['sessionId']);
      const session = deps.sessions.resolve(sessionId);
      const png = await provider.screenshot(session.url, await buildOpts(deps, sessionId, args));
      if (png === undefined) return { ok: false, reason: VisualReason.CAPTURE_FAILED };
      const name = asString(args['name']) ?? 'default';
      const store = new VisualStore(deps.fs, deps.reticleRoot);
      const path = await store.saveBaseline(name, png);
      return { ok: true, saved: true, name, path, bytes: png.length };
    },
  },
  {
    name: ReticleTool.VISUAL_DIFF,
    description:
      'Perceptually diff the DRIVEN page against a saved visual baseline (see reticle_screenshot). { masks:[{x,y,width,height}] } neutralizes volatile regions; { maxRatio } sets the pass tolerance (default 0). Returns { matched, changedPixels, totalPixels, ratio, region?, diffPath, dimensionMismatch } — the overlay diff is written to .reticle/visual/<baseline>.diff.png — or { ok:false, reason } (no-provider / baseline-missing).',
    inputSchema: {
      baseline: z
        .string()
        .describe(
          'Baseline screenshot name (from reticle_screenshot). Used to compare with the current screenshot.',
        ),
      fullPage: z.boolean().optional(),
      ref: z.string().optional(),
      clip: rectShape.optional(),
      masks: z.array(rectShape).optional(),
      maxRatio: z.number().optional(),
      threshold: z.number().optional().describe('Pixel difference threshold (0–1). Default: 0.01.'),
      ...sessionIdShape,
    },
    outputSchema: {
      ok: z.boolean(),
      matched: z.boolean().optional(),
      changedPixels: z.number().optional(),
      totalPixels: z.number().optional(),
      ratio: z.number().optional(),
      region: rectShape.optional(),
      dimensionMismatch: z.boolean().optional(),
      diffPath: z.string().optional(),
      reason: z.string().optional(),
    },
    handler: async (deps: ToolDeps, args) => {
      const provider = screenshotProvider(deps);
      if (provider === undefined) return noProvider;
      const baseline = asString(args['baseline']) ?? '';
      const store = new VisualStore(deps.fs, deps.reticleRoot);
      const baselineBytes = await store.readBaseline(baseline);
      if (baselineBytes === undefined) return { ok: false, reason: VisualReason.BASELINE_MISSING };

      const sessionId = asString(args['sessionId']);
      const session = deps.sessions.resolve(sessionId);
      const current = await provider.screenshot(
        session.url,
        await buildOpts(deps, sessionId, args),
      );
      if (current === undefined) return { ok: false, reason: VisualReason.CAPTURE_FAILED };

      const masks = rectsFrom(args['masks']);
      const threshold = asNumber(args['threshold']);
      const maxRatio = asNumber(args['maxRatio']);
      const result = await diffPng(baselineBytes, current, {
        ...(threshold !== undefined ? { threshold } : {}),
        ...(maxRatio !== undefined ? { maxRatio } : {}),
        ...(masks !== undefined ? { masks } : {}),
      });

      // Omit the raw diff bytes from the JSON result; persist them and return the path instead.
      const { diffPng: diffBytes, ...verdict } = result;
      if (diffBytes === undefined) {
        return { ok: false, ...verdict, reason: VisualReason.DIMENSION_MISMATCH };
      }
      const diffPath = await store.saveDiff(baseline, diffBytes);
      return { ok: true, ...verdict, diffPath };
    },
  },
];
