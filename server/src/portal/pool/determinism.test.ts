/**
 * The deterministic-lease page script, run in a fresh `vm` realm.
 *
 * The script is serialised into the page, so it runs here from its own source text, the way
 * Playwright sends it. A script that reads a name from outside itself fails here first.
 */
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { DETERMINISM_FRAME_MS } from '@reticlehq/core';
import {
  determinismConfigOf,
  installDeterminism,
  leaseDeterminismOf,
  stepPage,
  type DeterminismConfig,
} from './determinism.js';

interface Realm {
  run: (code: string) => unknown;
  log: string[];
}

/** A fresh realm with the page globals the script replaces, and the script installed in it. */
function realmWith(config: DeterminismConfig): Realm {
  const log: string[] = [];
  const context = vm.createContext({
    log,
    // The page's real timer: here it runs a callback at once and records what it threw.
    setTimeout: (cb: () => void): number => {
      try {
        cb();
      } catch (error) {
        log.push(`reported:${String(error)}`);
      }
      return 0;
    },
    clearTimeout,
    performance: { now: (): number => 123.4 },
    crypto: {
      getRandomValues: (a: Uint8Array): Uint8Array => a,
      randomUUID: (): string => 'real',
    },
    requestAnimationFrame: (): number => 0,
    cancelAnimationFrame: (): void => undefined,
    navigator: {
      platform: 'MacIntel',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      userAgentData: { platform: 'macOS' },
    },
  });
  vm.runInContext(`(${installDeterminism.toString()})(${JSON.stringify(config)})`, context);
  return { run: (code): unknown => vm.runInContext(code, context) as unknown, log };
}

const config = (seed = 7, platform?: string): DeterminismConfig =>
  determinismConfigOf(platform === undefined ? { seed } : { seed, platform });

const STEP = (frames: number): string =>
  `globalThis[Symbol.for(${JSON.stringify(config().key)})].step(${String(frames)})`;

describe('installDeterminism — random', () => {
  it('gives the same Math.random sequence for the same seed, and another for another seed', () => {
    const draw = 'Array.from({ length: 5 }, () => Math.random())';
    const a = realmWith(config(7)).run(draw) as number[];
    const b = realmWith(config(7)).run(draw) as number[];
    const c = realmWith(config(8)).run(draw) as number[];
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a.every((n) => n >= 0 && n < 1)).toBe(true);
  });

  it('fills crypto.getRandomValues and randomUUID from the same seed', () => {
    const draw =
      'JSON.stringify([Array.from(crypto.getRandomValues(new Uint8Array(8))), crypto.randomUUID()])';
    const a = realmWith(config(7)).run(draw);
    expect(realmWith(config(7)).run(draw)).toBe(a);
    expect(realmWith(config(9)).run(draw)).not.toBe(a);
    const [, uuid] = JSON.parse(String(a)) as [number[], string];
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('installDeterminism — clock and frames', () => {
  it('starts Date and performance.now at the fixed epoch, and holds them until a step', async () => {
    const realm = realmWith(config());
    expect(realm.run('performance.now()')).toBe(0);
    expect(realm.run('Date.now()')).toBe(config().epochMs);
    expect(realm.run('new Date().getTime()')).toBe(config().epochMs);
    expect(realm.run('new Date(5).getTime()')).toBe(5);
    expect(realm.run('new Date() instanceof Date')).toBe(true);
    expect(typeof realm.run('Date()')).toBe('string');
    await realm.run(STEP(3));
    expect(realm.run('performance.now()')).toBeCloseTo(3 * DETERMINISM_FRAME_MS);
    expect(realm.run('Date.now()')).toBeCloseTo(config().epochMs + 3 * DETERMINISM_FRAME_MS);
  });

  it('runs due timers in time order, then the frame callbacks once per frame', async () => {
    const realm = realmWith(config());
    realm.run(`
      setTimeout(() => log.push('t20'), 20);
      setTimeout((a) => log.push('t5:' + a), 5, 'x');
      const iv = setInterval(() => { log.push('iv'); if (log.filter((e) => e === 'iv').length === 3) clearInterval(iv); }, 10);
      const gone = setTimeout(() => log.push('cleared'), 1);
      clearTimeout(gone);
      requestAnimationFrame((t) => {
        log.push('raf1@' + t.toFixed(2));
        requestAnimationFrame((t2) => log.push('raf2@' + t2.toFixed(2)));
      });
      const dropped = requestAnimationFrame(() => log.push('dropped'));
      cancelAnimationFrame(dropped);
    `);
    expect(realm.log).toEqual([]);
    const result = (await realm.run(STEP(1))) as { frame: number; nowMs: number };
    expect(realm.log).toEqual(['t5:x', 'iv', 'raf1@16.67']);
    expect(result).toEqual({ frame: 1, nowMs: DETERMINISM_FRAME_MS });
    await realm.run(STEP(1));
    expect(realm.log).toEqual(['t5:x', 'iv', 'raf1@16.67', 't20', 'iv', 'iv', 'raf2@33.33']);
    await realm.run(STEP(2));
    expect(realm.log.filter((e) => 'iv' === e)).toHaveLength(3);
    expect(realm.log).not.toContain('cleared');
    expect(realm.log).not.toContain('dropped');
  });

  it('keeps running the other callbacks when one throws', async () => {
    const realm = realmWith(config());
    realm.run(`
      requestAnimationFrame(() => { throw new Error('boom'); });
      requestAnimationFrame(() => log.push('after'));
    `);
    await realm.run(STEP(1));
    expect(realm.log).toEqual(['reported:Error: boom', 'after']);
  });

  it('keeps the real timers for the SDK under the shared key', () => {
    const realm = realmWith(config());
    const key = JSON.stringify(config().key);
    expect(realm.run(`typeof globalThis[Symbol.for(${key})].natives.setTimeout`)).toBe('function');
    expect(realm.run(`globalThis[Symbol.for(${key})].natives.performanceNow()`)).toBe(123.4);
  });
});

describe('installDeterminism — platform', () => {
  it('leaves the platform alone when none is given', () => {
    expect(realmWith(config()).run('navigator.platform')).toBe('MacIntel');
  });

  it('reports the given platform in navigator.platform, userAgentData and userAgent', () => {
    const realm = realmWith(config(7, 'Linux x86_64'));
    expect(realm.run('navigator.platform')).toBe('Linux x86_64');
    expect(realm.run('navigator.userAgentData.platform')).toBe('Linux');
    expect(realm.run('navigator.userAgent')).toBe(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    );
  });
});

describe('leaseDeterminismOf', () => {
  it('reads an empty object as the default seed, and refuses a field it does not know', () => {
    expect(leaseDeterminismOf(undefined)).toBeUndefined();
    expect(determinismConfigOf(leaseDeterminismOf({}) ?? {}).seed).toBe(config(1).seed);
    expect(leaseDeterminismOf({ seed: 3, platform: 'Win32' })).toEqual({
      seed: 3,
      platform: 'Win32',
    });
    expect(() => leaseDeterminismOf({ sead: 3 })).toThrow(/deterministic/);
  });
});

describe('stepPage', () => {
  it('reads the step result, and undefined from a page without the script', async () => {
    const realm = realmWith(config());
    const page = {
      evaluate: (script: string): Promise<unknown> => Promise.resolve(realm.run(script)),
    };
    expect(await stepPage(page, 2)).toEqual({ frame: 2, nowMs: 2 * DETERMINISM_FRAME_MS });
    const bare = { evaluate: (): Promise<unknown> => Promise.resolve(undefined) };
    expect(await stepPage(bare, 2)).toBeUndefined();
    expect(await stepPage({}, 2)).toBeUndefined();
  });
});
