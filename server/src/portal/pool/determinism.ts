/**
 * A deterministic lease: the same page, driven the same way, gives the same pixels and text.
 *
 * Two runs of a canvas game differ because time and randomness differ. This script replaces both
 * before any page script runs. Math.random and crypto take values from a seeded generator. Date,
 * performance.now, the timers and requestAnimationFrame read a virtual clock that starts at a fixed
 * epoch. The clock moves only when the caller steps frames, through `reticle_clock { stepFrames }`.
 *
 * The SDK in the page must keep real time, or it cannot wait, reconnect or send its heartbeat. The
 * script keeps the real timers under `DETERMINISM_GLOBAL_KEY`, and the SDK reads them from there.
 */
import { z } from 'zod';
import {
  DETERMINISM_DEFAULT_SEED,
  DETERMINISM_EPOCH_MS,
  DETERMINISM_FRAME_MS,
  DETERMINISM_GLOBAL_KEY,
  DETERMINISM_MAX_STEP_FRAMES,
} from '@reticlehq/core';

/** What the caller asks for. */
export interface DeterminismOptions {
  seed?: number;
  /** The value of `navigator.platform`, for example "Linux x86_64". Absent keeps the real one. */
  platform?: string;
}

/** What the page script is given. Plain data, because Playwright sends it as JSON. */
export interface DeterminismConfig {
  key: string;
  seed: number;
  epochMs: number;
  frameMs: number;
  platform?: string;
}

/** What one step reports: the frames stepped since the page loaded, and the virtual time. */
export interface DeterminismStep {
  frame: number;
  nowMs: number;
}

export const DeterminismSchema = z
  .object({
    seed: z.number().int().min(0).max(0xffffffff).optional(),
    platform: z.string().min(1).max(64).optional(),
  })
  .strict();

export const LEASE_DETERMINISTIC_ARG = DeterminismSchema.optional().describe(
  'Make the leased tab deterministic, for canvas games and animations. Before any page script ' +
    'runs, Math.random and crypto.getRandomValues use a seeded generator (seed, default 1). Date, ' +
    'performance.now, setTimeout, setInterval and requestAnimationFrame use a virtual clock that ' +
    'starts at 2026-01-01T00:00:00Z and moves only when you call reticle_clock { stepFrames: N }. ' +
    'devicePixelRatio is 1. platform sets navigator.platform, for example "Linux x86_64". CSS ' +
    'animations, workers and media still run on real time. Example: deterministic: { seed: 7 }.',
);

/** A lease's `deterministic` argument, read; a field it does not know is refused by name. */
export function leaseDeterminismOf(raw: unknown): DeterminismOptions | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = DeterminismSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.') ?? '';
    throw new Error(
      `deterministic${'' === field ? '' : `.${field}`}: ${issue?.message ?? 'not valid'}`,
    );
  }
  const { seed, platform } = parsed.data;
  return {
    ...(seed === undefined ? {} : { seed }),
    ...(platform === undefined ? {} : { platform }),
  };
}

export function determinismConfigOf(opts: DeterminismOptions): DeterminismConfig {
  return {
    key: DETERMINISM_GLOBAL_KEY,
    seed: opts.seed ?? DETERMINISM_DEFAULT_SEED,
    epochMs: DETERMINISM_EPOCH_MS,
    frameMs: DETERMINISM_FRAME_MS,
    ...(opts.platform === undefined ? {} : { platform: opts.platform }),
  };
}

export const StepFramesSchema = z.number().int().min(1).max(DETERMINISM_MAX_STEP_FRAMES);

const StepResultSchema = z.object({ frame: z.number(), nowMs: z.number() });

/** Step the page's virtual clock by `frames` frames. Undefined when the page runs no such clock. */
export async function stepPage(
  page: { evaluate?(script: string): Promise<unknown> },
  frames: number,
): Promise<DeterminismStep | undefined> {
  if (page.evaluate === undefined) {
    return undefined;
  }
  const key = JSON.stringify(DETERMINISM_GLOBAL_KEY);
  const script = `globalThis[Symbol.for(${key})]?.step(${String(StepFramesSchema.parse(frames))})`;
  const parsed = StepResultSchema.safeParse(await page.evaluate(script));
  return parsed.success ? parsed.data : undefined;
}

type Callback = (...args: unknown[]) => void;
interface Timer {
  id: number;
  at: number;
  run: () => void;
  every?: number;
}
interface Frame {
  id: number;
  cb: (time: number) => void;
}
interface PageGlobal {
  Math: { random: () => number };
  Date: DateConstructor;
  setTimeout?: (cb: () => void, ms?: unknown, ...args: unknown[]) => unknown;
  clearTimeout?: (id: unknown) => void;
  setInterval?: unknown;
  clearInterval?: unknown;
  requestAnimationFrame?: ((cb: (time: number) => void) => number) | ((cb: unknown) => number);
  cancelAnimationFrame?: (id: unknown) => void;
  performance?: { now: () => number };
  crypto?: object;
  MessageChannel?: new () => {
    port1: { onmessage: (() => void) | null };
    port2: { postMessage(value: unknown): void };
  };
  navigator?: { userAgent?: string; userAgentData?: object };
}

/**
 * The page script. It must stay self-contained: Playwright sends its source text into the page, so
 * it can read nothing from this module. The unit test runs it from its source text for that reason.
 */
export function installDeterminism(config: DeterminismConfig): void {
  const g = globalThis as unknown as PageGlobal;
  const define = (target: object, name: string, value: unknown): void => {
    Object.defineProperty(target, name, { value, configurable: true, writable: true });
  };
  const getter = (target: object, name: string, value: unknown): void => {
    Object.defineProperty(target, name, { get: () => value, configurable: true });
  };

  // The real timers, kept before anything is replaced, for the SDK and for this script.
  const realSetTimeout = g.setTimeout?.bind(g);
  const realClearTimeout = g.clearTimeout?.bind(g);
  const realFrame =
    'function' === typeof g.requestAnimationFrame ? g.requestAnimationFrame.bind(g) : undefined;
  const realPerformanceNow = g.performance?.now.bind(g.performance);

  // Random: mulberry32, a small 32-bit generator. The same seed gives the same sequence.
  let state = config.seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  g.Math.random = next;
  const fill = <T extends ArrayBufferView>(view: T): T => {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(next() * 256);
    }
    return view;
  };
  if (g.crypto !== undefined) {
    define(g.crypto, 'getRandomValues', fill);
    define(g.crypto, 'randomUUID', (): string => {
      const b = fill(new Uint8Array(16));
      b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
      b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
      const hex = Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    });
  }

  // Clock: `elapsed` is the virtual performance.now. It moves only in `step`.
  let elapsed = 0;
  let frame = 0;
  const RealDate = g.Date;
  const wallNow = (): number => config.epochMs + elapsed;
  const VirtualDate = function (...args: unknown[]): unknown {
    if (new.target === undefined) {
      return new RealDate(wallNow()).toString();
    }
    return Reflect.construct(RealDate, 0 === args.length ? [wallNow()] : args, new.target);
  } as unknown as DateConstructor;
  (VirtualDate as unknown as { prototype: unknown }).prototype = RealDate.prototype;
  define(VirtualDate, 'now', wallNow);
  define(VirtualDate, 'parse', RealDate.parse.bind(RealDate));
  define(VirtualDate, 'UTC', RealDate.UTC.bind(RealDate));
  g.Date = VirtualDate;
  if (g.performance !== undefined) {
    define(g.performance, 'now', () => elapsed);
  }

  let nextId = 1;
  const timers = new Map<number, Timer>();
  const schedule = (cb: unknown, ms: unknown, args: unknown[], repeat: boolean): number => {
    const id = nextId;
    nextId += 1;
    if ('function' !== typeof cb) {
      return id;
    }
    const delay = Math.max(0, Number(ms) || 0);
    const run = (): void => {
      (cb as Callback)(...args);
    };
    timers.set(id, {
      id,
      at: elapsed + delay,
      run,
      ...(repeat ? { every: Math.max(1, delay) } : {}),
    });
    return id;
  };
  const cancel = (id: unknown): void => {
    timers.delete(Number(id));
  };
  g.setTimeout = (cb: unknown, ms?: unknown, ...args: unknown[]): number =>
    schedule(cb, ms, args, false);
  g.setInterval = (cb: unknown, ms?: unknown, ...args: unknown[]): number =>
    schedule(cb, ms, args, true);
  g.clearTimeout = cancel;
  g.clearInterval = cancel;

  let frames: Frame[] = [];
  g.requestAnimationFrame = (cb: unknown): number => {
    const id = nextId;
    nextId += 1;
    if ('function' === typeof cb) {
      frames.push({ id, cb: cb as Frame['cb'] });
    }
    return id;
  };
  g.cancelAnimationFrame = (id: unknown): void => {
    frames = frames.filter((f) => f.id !== Number(id));
  };

  // A callback that throws is reported as the page reports it, and the rest still run. After each
  // callback the microtasks run, as they do in a browser between two tasks.
  const settle = (): Promise<void> =>
    new Promise((resolve) => {
      if (g.MessageChannel === undefined) {
        void Promise.resolve().then(resolve);
        return;
      }
      const channel = new g.MessageChannel();
      channel.port1.onmessage = (): void => {
        resolve();
      };
      channel.port2.postMessage(0);
    });
  const invoke = async (run: () => void): Promise<void> => {
    try {
      run();
    } catch (error) {
      realSetTimeout?.(() => {
        throw error;
      }, 0);
    }
    await settle();
  };
  const earliestDue = (until: number): Timer | undefined => {
    let found: Timer | undefined;
    for (const t of timers.values()) {
      if (t.at <= until && (found === undefined || t.at < found.at)) {
        found = t;
      }
    }
    return found;
  };
  const step = async (count: number): Promise<{ frame: number; nowMs: number }> => {
    for (let i = 0; i < count; i += 1) {
      frame += 1;
      const target = frame * config.frameMs;
      for (let guard = 0; guard < 100000; guard += 1) {
        const due = earliestDue(target);
        if (due === undefined) {
          break;
        }
        elapsed = Math.max(elapsed, due.at);
        timers.delete(due.id);
        if (due.every !== undefined) {
          timers.set(due.id, { ...due, at: due.at + due.every });
        }
        await invoke(due.run);
      }
      elapsed = target;
      const flush = frames;
      frames = [];
      for (const f of flush) {
        await invoke(() => {
          f.cb(target);
        });
      }
    }
    return { frame, nowMs: elapsed };
  };

  // Keyboard labels and shortcuts differ between Mac and Linux, so the platform can be set.
  const nav = g.navigator;
  if (config.platform !== undefined && nav !== undefined) {
    const platform = config.platform;
    const families: [string, string, string][] = [
      ['Mac', 'macOS', '(Macintosh; Intel Mac OS X 10_15_7)'],
      ['Win', 'Windows', '(Windows NT 10.0; Win64; x64)'],
      ['Linux', 'Linux', `(X11; ${platform})`],
    ];
    const family = families.find(([prefix]) => platform.startsWith(prefix));
    getter(nav, 'platform', platform);
    if (family !== undefined) {
      if (nav.userAgentData !== undefined) {
        getter(nav.userAgentData, 'platform', family[1]);
      }
      if (nav.userAgent !== undefined) {
        getter(nav, 'userAgent', nav.userAgent.replace(/\([^)]*\)/, family[2]));
      }
    }
  }

  Object.defineProperty(g, Symbol.for(config.key), {
    value: {
      step,
      natives: {
        setTimeout: realSetTimeout,
        clearTimeout: realClearTimeout,
        requestAnimationFrame: realFrame,
        performanceNow: realPerformanceNow,
      },
    },
    configurable: false,
    enumerable: false,
  });
}
