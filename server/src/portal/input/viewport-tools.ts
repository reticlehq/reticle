import { z } from 'zod';
import { CDP_NO_PROVIDER_REASON, VIEWPORT_NO_PROVIDER_RECOMMENDATION } from '@reticlehq/core';
import { ReticleTool } from '@reticlehq/core';
import { sessionIdShape } from '@/surface/tools/tool-kit.js';
import {
  MAX_VIEWPORT_PX,
  MIN_VIEWPORT_PX,
  viewportPxSchema,
} from '@/surface/tools/args/numeric-bounds.js';
import { asString } from '@reticlehq/core';
import { HEADLESS_VIEWPORT } from '@/chromium-launch-options.js';
import type { RealInputProvider } from './real-input.js';
import type { ToolDef, ToolDeps } from '@/surface/tools/tool-kit.js';
import {
  ColorScheme,
  Pointer,
  ReducedMotion,
  type LeaseEmulation,
  type LeaseMedia,
} from '@/portal/pool/lease-emulation.js';

// ── Media and width, as a tool call names them (reticle_viewport here, reticle_lease acquire) ──

/** The side a caller did not name is the page size a headless lease already opens with. */
const DEFAULT_WIDTH = HEADLESS_VIEWPORT.width;
const DEFAULT_HEIGHT = HEADLESS_VIEWPORT.height;

export const COLOR_SCHEME_ARG = z
  .enum([ColorScheme.LIGHT, ColorScheme.DARK, ColorScheme.NO_PREFERENCE])
  .optional()
  .describe('prefers-color-scheme for this page: light, dark or no-preference.');
export const REDUCED_MOTION_ARG = z
  .enum([ReducedMotion.REDUCE, ReducedMotion.NO_PREFERENCE])
  .optional()
  .describe('prefers-reduced-motion for this page: reduce or no-preference.');
export const POINTER_ARG = z
  .enum([Pointer.FINE, Pointer.COARSE])
  .optional()
  .describe(
    'The primary pointer this page reports to @media (pointer: ...): fine (a mouse) or coarse (touch). ' +
      'Settable only when the lease opens, because touch support is fixed for a browser context.',
  );

const EmulateSchema = z
  .object({
    colorScheme: COLOR_SCHEME_ARG,
    reducedMotion: REDUCED_MOTION_ARG,
    width: viewportPxSchema.optional(),
    height: viewportPxSchema.optional(),
    pointer: POINTER_ARG,
  })
  .strict();

export const LEASE_EMULATE_ARG = EmulateSchema.optional().describe(
  'Open the lease with these set before the first paint: { colorScheme, reducedMotion, width, height, pointer }. ' +
    'A side you leave out keeps its default (1440 by 900). Change the media and the size later with ' +
    'reticle_viewport; `pointer` cannot change on an open lease, so a touch-only rule needs a lease ' +
    'acquired with pointer: "coarse".',
);

/** The media part of what a caller asked for, or undefined when it asked for none. */
export function mediaOf(raw: {
  colorScheme?: unknown;
  reducedMotion?: unknown;
}): LeaseMedia | undefined {
  const parsed = EmulateSchema.pick({ colorScheme: true, reducedMotion: true }).parse({
    colorScheme: raw.colorScheme,
    reducedMotion: raw.reducedMotion,
  });
  const media: LeaseMedia = {
    ...(parsed.colorScheme === undefined ? {} : { colorScheme: parsed.colorScheme }),
    ...(parsed.reducedMotion === undefined ? {} : { reducedMotion: parsed.reducedMotion }),
  };
  return 0 === Object.keys(media).length ? undefined : media;
}

/** A lease's `emulate` argument, read; a value it does not know is refused by name. */
export function leaseEmulationOf(raw: unknown): LeaseEmulation | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = EmulateSchema.safeParse(raw);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join('.') ?? 'emulate';
    throw new Error(`emulate.${field}: ${parsed.error.issues[0]?.message ?? 'not valid'}`);
  }
  const { width, height, pointer } = parsed.data;
  const media = mediaOf(parsed.data);
  const viewport =
    width === undefined && height === undefined
      ? undefined
      : { width: width ?? DEFAULT_WIDTH, height: height ?? DEFAULT_HEIGHT };
  if (media === undefined && viewport === undefined && pointer === undefined) {
    return undefined;
  }
  return {
    ...media,
    ...(viewport === undefined ? {} : { viewport }),
    ...(pointer === undefined ? {} : { pointer }),
  };
}

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

/**
 * Whether this caller holds the session as a lease. Another agent's lease is never this caller's
 * to change (#1226).
 */
function holdsLease(deps: ToolDeps, sessionId: string): boolean {
  return true === deps.pool?.heldBy(sessionId, deps.attachId);
}

/** Whether this call can resize the session: a lease of this caller, or a driven page. */
async function canResize(
  deps: ToolDeps,
  session: { readonly id: string; readonly url: string },
): Promise<boolean> {
  if (holdsLease(deps, session.id)) {
    return true;
  }
  // A driven browser resizes only a page it has. Having a driven browser is not enough.
  const driven = viewportProvider(deps);
  if (driven === undefined) {
    return false;
  }
  return driven.isAvailableFor(session.url);
}

export const VIEWPORT_TOOLS: ToolDef[] = [
  {
    name: ReticleTool.VIEWPORT,
    description:
      'Pin the DRIVEN or LEASED page (needs `reticle drive`, or `reticle_lease` acquire when there is no CDP provider) to a fixed viewport size so a screenshot baseline is ' +
      'reproducible across machines — the missing piece of CI-stable visual regression, alongside ' +
      'reticle_visual_diff `masks` and a frozen clock (reticle_clock). Set it once before reticle_screenshot / ' +
      'reticle_visual_diff. On a lease it also sets prefers-color-scheme and prefers-reduced-motion; ' +
      'give only those to change the media and keep the size. A `pointer` is refused here: touch support is fixed when a lease opens, so ask for it with reticle_lease acquire `emulate.pointer`. ' +
      'Returns { applied, width, height, observed } or the no-provider recommendation; `observed` is the size the leased page reports after the resize.',
    inputSchema: {
      width: viewportPxSchema.optional().describe('Viewport width in CSS px (e.g. 1280).'),
      height: viewportPxSchema.optional().describe('Viewport height in CSS px (e.g. 800).'),
      colorScheme: COLOR_SCHEME_ARG,
      reducedMotion: REDUCED_MOTION_ARG,
      pointer: POINTER_ARG,
      ...sessionIdShape,
    },
    outputSchema: {
      applied: z.boolean(),
      width: z.number().optional(),
      height: z.number().optional(),
      observed: z.object({ width: z.number(), height: z.number() }).optional(),
      colorScheme: z.string().optional(),
      reducedMotion: z.string().optional(),
      pointer: z.string().optional(),
      ok: z.boolean().optional(),
      reason: z.string().optional(),
      recommendation: z.string().optional(),
    },
    handler: async (deps, args) => {
      // Touch support is a Playwright context option and a lease is one context, so a pointer can
      // only be chosen when the lease opens. Said out loud instead of dropped: a silently ignored
      // `pointer` would hand back a verdict about a touch-only rule that was taken with a mouse.
      if (args['pointer'] !== undefined) {
        return {
          applied: false,
          ok: false,
          reason: POINTER_IS_FIXED,
          recommendation: POINTER_NEEDS_A_NEW_LEASE,
        };
      }
      const media = mediaOf(args);
      if (media !== undefined && args['width'] === undefined && args['height'] === undefined) {
        // Only a lease can set the media.
        const session = await deps.sessions.resolveServing(asString(args['sessionId']), (s) =>
          holdsLease(deps, s.id),
        );
        if (true === (await deps.pool?.emulateLease(session.id, media))) {
          // No size was asked for, so answer the one the lease has; 0 by 0 reads as a broken
          // viewport (#1902). When the page cannot be read, leave the size out.
          const size = await deps.pool?.viewportOfLease(session.id);
          return { applied: true, ...size, ...media };
        }
        return { ...refused(), recommendation: MEDIA_NEEDS_A_LEASE };
      }
      const width = clampDim('width', args['width']);
      const height = clampDim('height', args['height']);
      const session = await deps.sessions.resolveServing(asString(args['sessionId']), (s) =>
        canResize(deps, s),
      );
      // A lease is resized as the lease. The driven provider resizes its own page, whatever
      // session was named, so taking it first resized the wrong tab and said `applied: true`.
      const driven = viewportProvider(deps);
      const provider =
        driven !== undefined && deps.pool?.leaseUrl(session.id) === undefined ? driven : undefined;
      if (provider !== undefined) {
        const applied = await provider.setViewport(session.url, { width, height });
        // The driven page takes the size; its media stay as the person's browser has them.
        if (applied && media === undefined) {
          return { applied: true, width, height };
        }
        if (applied) {
          return { applied: true, width, height, recommendation: MEDIA_NEEDS_A_LEASE };
        }
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
      if (true !== leased) {
        return refused();
      }
      // What the page reports after the resize, so `applied` is a reading and not a hope.
      const observed = await deps.pool?.viewportOfLease(session.id);
      if (observed !== undefined && (observed.width !== width || observed.height !== height)) {
        return { applied: false, width, height, observed, ok: false, reason: VIEWPORT_NOT_TAKEN };
      }
      const seen = observed === undefined ? {} : { observed };
      if (media === undefined) {
        return { applied: true, width, height, ...seen };
      }
      if (true === (await deps.pool?.emulateLease(session.id, media))) {
        return { applied: true, width, height, ...seen, ...media };
      }
      return { ...refused(), width, height, recommendation: MEDIA_NEEDS_A_LEASE };
    },
  },
];

/** The resize went through, but the page still reports another size. */
const VIEWPORT_NOT_TAKEN =
  'the page still reports the size in `observed` after the resize, so the size was not applied';

/** Touch support rides on the browser context, so an open lease's pointer cannot be changed. */
const POINTER_IS_FIXED =
  "a lease's pointer is fixed when its context opens, so it cannot be changed on a live lease";
const POINTER_NEEDS_A_NEW_LEASE =
  'Acquire a new lease with emulate.pointer: reticle_lease { action: "acquire", emulate: { pointer: "coarse" } }, then call this again with its sessionId.';

/** prefers-color-scheme and prefers-reduced-motion are set on a leased page only. */
const MEDIA_NEEDS_A_LEASE =
  'Media features are set on a leased tab: open one with reticle_lease { action: "acquire", emulate }, then call this again with its sessionId.';

function refused(): {
  applied: false;
  width: number;
  height: number;
  ok: false;
  reason: string;
  recommendation: string;
} {
  return {
    applied: false,
    width: 0,
    height: 0,
    ok: false,
    reason: CDP_NO_PROVIDER_REASON,
    recommendation: VIEWPORT_NO_PROVIDER_RECOMMENDATION,
  };
}

/**
 * Clamp a requested dimension into [MIN_DIM, MAX_DIM]; a missing value falls back to MIN_DIM.
 *
 * A value that is PRESENT but not a finite number is refused, not read as missing: a client that
 * sent `"1440"` meant 1440, and answering with a 64px page it never asked for made every later
 * snapshot, click and screenshot on that page read as broken (#1118).
 */
function clampDim(key: string, value: unknown): number {
  if (value === undefined) {
    return MIN_DIM;
  }
  if ('number' !== typeof value || !Number.isFinite(value)) {
    throw new Error(
      `${ReticleTool.VIEWPORT}: \`${key}\` must be a number of CSS px, got ${JSON.stringify(value)} — NOT applied`,
    );
  }
  return Math.max(MIN_DIM, Math.min(Math.round(value), MAX_DIM));
}
