import { describe, expect, it, vi } from 'vitest';
import { fillValues, heuristicFillValue, needsGeneration, type FillCache } from './fill-values.js';
import type { HarnessFetch } from './driver.js';

/**
 * The one place in a drive worth paying a generating model for, and the rules that keep it there.
 *
 * Measured across 91 recorded flows on a production dashboard: 413 clicks against 26 text steps.
 * Text is about 6% of what a drive does, so a model that writes text belongs on that 6% and nowhere
 * near the other 94% -- put it in the per-turn loop and it costs the per-turn tax the cheap driver
 * exists to avoid. Most of these tests are therefore about NOT calling it.
 */

const answering = (text: string): HarnessFetch =>
  vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ content: [{ type: 'text', text }] })),
    }),
  );

const generator = (fetch: HarnessFetch) => ({ apiKey: 'sk-test', fetch });

const memoryCache = (): FillCache & { seen: Map<string, string> } => {
  const seen = new Map<string, string>();
  return { seen, get: (k) => seen.get(k), set: (k, v) => void seen.set(k, v) };
};

describe('what a drive types into a field', () => {
  it('answers from the label alone when the label is enough', async () => {
    const fetch = answering('anything');
    const fill = fillValues({ generator: generator(fetch) });
    expect(await fill('Email address')).toBe('harness@reticle.dev');
    expect(fetch).not.toHaveBeenCalled();
  });

  /** The gap generation exists to close: typing the words "reticle harness" into an unknown box. */
  it('asks a model for a field the label heuristic cannot guess', async () => {
    const fetch = answering('Northwind Trading Co.');
    const fill = fillValues({ generator: generator(fetch) });
    expect(await fill('Business name')).toBe('Northwind Trading Co.');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to the heuristic with no generator configured', async () => {
    expect(await fillValues({})('Business name')).toBe(heuristicFillValue('Business name'));
  });

  it('never lets a refused or broken model fail the drive', async () => {
    const dead: HarnessFetch = vi.fn(() => Promise.reject(new Error('offline')));
    expect(await fillValues({ generator: generator(dead) })('Business name')).toBe(
      'reticle harness',
    );
  });

  it('refuses an answer that is prose rather than a value', async () => {
    const chatty = answering(
      'Sure! For a business name field you could use something like "Acme Corporation", which is a ' +
        'classic placeholder that most forms will accept without complaint.',
    );
    expect(await fillValues({ generator: generator(chatty) })('Business name')).toBe(
      'reticle harness',
    );
  });

  it('takes the value out of quotes a model wrapped it in', async () => {
    const quoted = answering('"Northwind"');
    expect(await fillValues({ generator: generator(quoted) })('Business name')).toBe('Northwind');
  });
});

describe('paying for a value once', () => {
  it('reuses what the project already learned, without asking again', async () => {
    const cache = memoryCache();
    cache.set('Business name', 'Northwind Trading Co.');
    const fetch = answering('Something Else Ltd.');
    const fill = fillValues({ cache, generator: generator(fetch) });
    expect(await fill('Business name')).toBe('Northwind Trading Co.');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('remembers a generated value for the next drive', async () => {
    const cache = memoryCache();
    const fetch = answering('Northwind Trading Co.');
    await fillValues({ cache, generator: generator(fetch) })('Business name');
    expect(cache.seen.get('Business name')).toBe('Northwind Trading Co.');
  });

  /** Keyed by the LABEL: a ref expires with the page, a label is what the next drive will meet. */
  it('answers the same field the same way twice within one drive', async () => {
    const fetch = answering('Northwind Trading Co.');
    const fill = fillValues({ cache: memoryCache(), generator: generator(fetch) });
    expect(await fill('Business name')).toBe(await fill('Business name'));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  /** The first drive on a form-heavy app is the one that pays, and it must not pay without limit. */
  it('stops generating once a drive has spent its allowance', async () => {
    const fetch = answering('a value');
    const fill = fillValues({ generator: generator(fetch) });
    for (let i = 0; i < 20; i += 1) await fill(`Unguessable field ${String(i)}`);
    expect(
      (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length,
    ).toBeLessThanOrEqual(12);
  });
});

describe('which labels are worth a model call', () => {
  it.each([
    ['Email address', false],
    ['Amount (INR)', false],
    ['Search transactions', false],
    ['Business name', true],
    ['Statement descriptor', true],
  ])('%s', (label, expected) => {
    expect(needsGeneration(label)).toBe(expected);
  });
});
