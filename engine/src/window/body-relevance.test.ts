import { describe, expect, it } from 'vitest';
import { bodyIsEvidence, type BodyMode } from './body-relevance.js';

/**
 * Which network bodies are worth their bytes.
 *
 * Measured on a real connected drive of the bench app: `reticle_network` returned 59,458 bytes and
 * was 90.9% of every byte that whole drive spent. Almost all of it was the response bodies of
 * successful asset fetches the dev server issued — module scripts the agent never asked about.
 *
 * `bodies: false` already existed and would have cut it, but the default was `true`, so an agent
 * paid the full amount unless it knew the flag existed. A capability nobody is told about is one
 * nobody uses, and the expensive answer being the default is why this was never noticed.
 *
 * The cut has to be a ROUTE cut and not an EVIDENCE cut, and this repo has already measured what
 * happens when that line is crossed: the `lean` surface dropped evidence tools, fixed 3 of 5 bugs
 * against the full surface's 5, and produced this project's first false green. So a body is kept
 * whenever it could decide a verdict — every failure, and anything the caller asked about by name —
 * and dropped only for calls that succeeded and nobody named.
 */
describe('bodyIsEvidence', () => {
  const call = (status: number | string | undefined, extra = {}) => ({ status, ...extra });

  it('keeps every body when the caller asks for all of them', () => {
    expect(bodyIsEvidence(call(200), 'all')).toBe(true);
    expect(bodyIsEvidence(call(500), 'all')).toBe(true);
  });

  it('drops every body when the caller asks for none', () => {
    expect(bodyIsEvidence(call(200), 'none')).toBe(false);
    expect(bodyIsEvidence(call(500), 'none')).toBe(false);
  });

  describe('auto — the new default', () => {
    const mode: BodyMode = 'auto';

    it('KEEPS a failed call, because the body is where the reason is', () => {
      expect(bodyIsEvidence(call(500), mode)).toBe(true);
      expect(bodyIsEvidence(call(404), mode)).toBe(true);
      expect(bodyIsEvidence(call(422), mode)).toBe(true);
    });

    it('keeps a call the caller could not have scored — no status, or a derived one', () => {
      // Desktop IPC has no HTTP status. Treating "unknown" as success is exactly the reading that
      // turns an unverifiable call into an assumed one.
      expect(bodyIsEvidence(call(undefined), mode)).toBe(true);
      expect(bodyIsEvidence(call(undefined, { ok: false }), mode)).toBe(true);
    });

    it('drops a successful GET of a build artifact — the actual bulk', () => {
      // 68% of a real drive's network payload was URLs of exactly this shape.
      for (const url of [
        'http://localhost:4312/src/main.tsx',
        'http://localhost:4312/@vite/client',
        'http://localhost:4312/node_modules/.vite/deps/react.js',
        'http://localhost:4312/assets/index-a1b2.css',
        'http://localhost:4312/logo.svg',
      ]) {
        expect(bodyIsEvidence(call(200, { method: 'GET', url }), mode), url).toBe(false);
      }
    });

    it('KEEPS a successful mutation — its body is what it changed', () => {
      // This is the case a status-only rule got wrong, and the repo's existing network test caught
      // it: `POST /api/todos -> {"id":7}` is the answer to "did that click create the todo".
      expect(bodyIsEvidence(call(201, { method: 'POST', url: '/api/todos' }), mode)).toBe(true);
      expect(bodyIsEvidence(call(200, { method: 'DELETE', url: '/api/todos/7' }), mode)).toBe(true);
    });

    it('KEEPS data the app exchanged, even on a plain GET', () => {
      expect(
        bodyIsEvidence(
          call(200, { method: 'GET', url: '/api/todos', contentType: 'application/json' }),
          mode,
        ),
      ).toBe(true);
      // An unremarkable GET that is not an asset is kept too — silence is only for build output.
      expect(bodyIsEvidence(call(200, { method: 'GET', url: '/api/health' }), mode)).toBe(true);
    });

    it('keeps a successful call the caller NAMED, because naming it is asking about it', () => {
      // `urlContains: '/api/pay'` means the agent is asking about that call specifically; answering
      // with everything except its body would be the tool refusing the actual question.
      expect(bodyIsEvidence(call(200), mode, { named: true })).toBe(true);
    });

    it('treats an explicit ok:false as a failure whatever the status says', () => {
      expect(bodyIsEvidence(call(200, { ok: false }), mode)).toBe(true);
    });
  });
});
