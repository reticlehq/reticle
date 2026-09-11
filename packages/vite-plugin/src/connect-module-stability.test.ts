/**
 * The connect module must be STABLE once its content has settled.
 *
 * The dev-server middleware drops the cached `/@reticle-connect` module so a daemon that starts
 * after Vite still gets a tokened connect. It used to do that on EVERY request for the module,
 * forever — including the request a page reload makes. A module that is force-invalidated on every
 * load is re-resolved against the dep optimizer on every load, and that is the shape of an
 * unbounded reload loop: reload → request → invalidate → re-resolve → reload. A user on a
 * non-default port reported exactly that, with the whole page reloading about once a second and
 * `/@reticle-connect` fetched in every cycle.
 *
 * The invariant is not a duration and not a reload count. It is: for an unchanged config, the
 * module's id and content do not change, so nothing may be invalidated after the first serve.
 */
import { afterAll, describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReticleEnv } from '@reticlehq/core';
import {
  reticle,
  RETICLE_CONNECT_MODULE,
  RETICLE_VITE_PLUGIN_NAME,
  type ViteDevServerLike,
} from './index.js';

/** The daemon's token file name, mirrored from ensure-token — the one input allowed to change. */
const PAIRING_TOKEN_FILE = 'pairing-token';

const emptyTokenDir = mkdtempSync(join(tmpdir(), 'reticle-vite-stability-'));
const savedTokenDir = process.env[ReticleEnv.PAIRING_TOKEN_DIR];
process.env[ReticleEnv.PAIRING_TOKEN_DIR] = emptyTokenDir;
afterAll(() => {
  if (savedTokenDir === undefined) delete process.env[ReticleEnv.PAIRING_TOKEN_DIR];
  else process.env[ReticleEnv.PAIRING_TOKEN_DIR] = savedTokenDir;
});

/** A non-default port — the configuration the field report was filed against. */
const CUSTOM_PORT = 4401;

interface Recorder {
  server: ViteDevServerLike;
  handler: (req: { url?: string | undefined }, res: unknown, next: () => void) => void;
  invalidations: number;
}

/**
 * A dev server that always HAS the connect module in its graph — the state a page reload leaves
 * behind, and the only state in which an invalidation does anything.
 */
function recordingServer(): Recorder {
  const rec: Recorder = {
    invalidations: 0,
    handler: () => undefined,
    server: {
      middlewares: {
        use(handler) {
          rec.handler = handler;
        },
      },
      moduleGraph: {
        getModuleById(id) {
          return id === RETICLE_CONNECT_MODULE ? { id } : undefined;
        },
        invalidateModule() {
          rec.invalidations++;
        },
      },
    },
  };
  return rec;
}

/** One page load: the middleware sees the request, then the pipeline loads the module. */
function serveOnce(rec: Recorder, plugin: { load: (id: string) => string | null }): string | null {
  let nexted = false;
  rec.handler({ url: RETICLE_CONNECT_MODULE }, undefined, () => {
    nexted = true;
  });
  expect(nexted).toBe(true);
  return plugin.load(RETICLE_CONNECT_MODULE);
}

describe('connect module stability', () => {
  it('does not invalidate its own module again once the served content has settled', () => {
    const plugin = reticle({ port: CUSTOM_PORT, root: process.cwd() });
    const rec = recordingServer();
    plugin.configureServer?.(rec.server);

    const first = serveOnce(rec, plugin);
    const invalidationsAfterFirst = rec.invalidations;

    // Ten more page loads with nothing changed. A reload loop is exactly this sequence, so if the
    // plugin keeps invalidating here it keeps feeding the loop.
    for (let i = 0; i < 10; i++) {
      expect(serveOnce(rec, plugin)).toBe(first);
    }
    expect(rec.invalidations).toBe(invalidationsAfterFirst);
  });

  it('resolves to the same id and the same source across repeated calls', () => {
    const plugin = reticle({ port: CUSTOM_PORT, root: process.cwd() });
    const ids = [0, 1, 2].map(() => plugin.resolveId(RETICLE_CONNECT_MODULE, undefined));
    expect(new Set(ids).size).toBe(1);
    const sources = [0, 1, 2].map(() => plugin.load(RETICLE_CONNECT_MODULE));
    expect(new Set(sources).size).toBe(1);
    expect(sources[0]).toContain(String(CUSTOM_PORT));
  });

  it('still invalidates when the served content would actually change', () => {
    // The reason the middleware exists: a token minted after the dev server started must reach the
    // page without a restart. Content-keyed invalidation has to keep doing that.
    const plugin = reticle({ port: CUSTOM_PORT, root: process.cwd(), token: 'first' });
    const rec = recordingServer();
    plugin.configureServer?.(rec.server);
    serveOnce(rec, plugin);
    const settled = rec.invalidations;
    serveOnce(rec, plugin);
    expect(rec.invalidations).toBe(settled);

    const changed = reticle({ port: CUSTOM_PORT, root: process.cwd(), token: 'second' });
    const rec2 = recordingServer();
    changed.configureServer?.(rec2.server);
    expect(serveOnce(rec2, changed)).not.toBe(serveOnce(rec, plugin));
    expect(rec2.invalidations).toBeGreaterThan(0);
  });

  it('says so once when the served source will not settle', () => {
    // Defensive: if some input we do not control oscillates, the loop stops being mysterious. The
    // token is the input that is genuinely allowed to change, so it stands in for any of them.
    const churnDir = mkdtempSync(join(tmpdir(), 'reticle-vite-churn-'));
    process.env[ReticleEnv.PAIRING_TOKEN_DIR] = churnDir;
    try {
      const warnings: string[] = [];
      const plugin = reticle({
        port: CUSTOM_PORT,
        root: process.cwd(),
        onWarn: (message) => warnings.push(message),
      });
      const rec = recordingServer();
      plugin.configureServer?.(rec.server);
      for (let i = 0; i < 12; i++) {
        writeFileSync(join(churnDir, PAIRING_TOKEN_FILE), `token-${String(i)}`, 'utf8');
        serveOnce(rec, plugin);
      }
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(RETICLE_VITE_PLUGIN_NAME);
    } finally {
      process.env[ReticleEnv.PAIRING_TOKEN_DIR] = emptyTokenDir;
    }
  });

  it('leaves the module alone for requests that are not for it', () => {
    const plugin = reticle({ port: CUSTOM_PORT, root: process.cwd() });
    const rec = recordingServer();
    plugin.configureServer?.(rec.server);
    rec.handler({ url: '/src/main.tsx' }, undefined, () => undefined);
    expect(rec.invalidations).toBe(0);
  });
});
