import { describe, expect, it } from 'vitest';
import { consoleLines, isLoadedRead, isPendingLine, networkLines } from './effect-lines.js';

describe('networkLines', () => {
  it('keeps method, path with query keys, status, and the start of the request body', () => {
    expect(
      networkLines({
        calls: [
          {
            method: 'POST',
            url: 'http://localhost:8787/api/items?id=42&t=1700000000',
            status: 500,
            requestBody: '{"name":"Reticle 42"}',
            ms: 12,
          },
          { method: 'GET', url: '/api/health', status: 200 },
        ],
      }),
    ).toEqual([
      'net: POST /api/items?id=&t= 500 {"name":"Reticle 42"}',
      'net: GET /api/health 200',
    ]);
  });

  it('folds a repeated identical read into one, and keeps a repeated write', () => {
    // A list that loads one more page on one run is not a change in behaviour; a second POST is.
    expect(
      networkLines({
        calls: [
          { method: 'GET', url: '/api/pages?page=1', status: 200 },
          { method: 'GET', url: '/api/pages?page=2', status: 200 },
          { method: 'POST', url: '/api/generate', status: 200, requestBody: '{}' },
          { method: 'POST', url: '/api/generate', status: 200, requestBody: '{}' },
        ],
      }),
    ).toEqual([
      'net: GET /api/pages?page= 200',
      'net: POST /api/generate 200 {}',
      'net: POST /api/generate 200 {}',
    ]);
  });

  it('names a read that loaded, and not a read that failed or a write', () => {
    // A restyle that loads another font was reported as a different build (dashboard restyle i91, 2026-11-09).
    const lines = networkLines({
      calls: [
        { method: 'GET', url: '/fonts/gerbil.otf', status: 200 },
        { method: 'GET', url: '/api/items?page=2', status: 304 },
        { method: 'GET', url: '/img/hero.webp', status: 404 },
        { method: 'GET', url: '/slow', status: 'pending' },
        { method: 'POST', url: '/upload/photo.png', status: 201 },
      ],
    });
    expect(lines.map(isLoadedRead)).toEqual([true, true, false, false, false]);
  });

  it('cuts a long request body', () => {
    const [line] = networkLines({
      calls: [{ method: 'POST', url: '/x', status: 200, requestBody: 'a'.repeat(500) }],
    });
    expect(line?.length).toBeLessThan(200);
  });

  it('names a call still in flight as pending', () => {
    const lines = networkLines({ calls: [{ method: 'GET', url: '/slow', status: 'pending' }] });
    expect(lines).toEqual(['net: GET /slow pending']);
    expect(lines.some(isPendingLine)).toBe(true);
  });

  it('writes a failed read as a line, so an empty list always means nothing happened', () => {
    expect(networkLines({ error: 'window_ms is not allowed' })).toEqual([
      'effects failed: network: window_ms is not allowed',
    ]);
    expect(networkLines(undefined)).toEqual(['effects failed: network: no answer']);
  });
});

describe('consoleLines', () => {
  it('keeps errors and warnings, not other levels', () => {
    expect(
      consoleLines({
        logs: [
          { level: 'log', text: 'hello' },
          { level: 'error', text: 'boom' },
          { level: 'warn', text: 'careful' },
        ],
      }),
    ).toEqual(['console error: boom', 'console warn: careful']);
  });

  it('writes a failed read as a line', () => {
    expect(consoleLines({ error: 'no session' })).toEqual(['effects failed: console: no session']);
  });
});
