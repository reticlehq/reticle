/**
 * A screenshot of one session never carries another tab's pixels (#1407).
 *
 * While `reticle drive` owned a page, `reticle_screenshot { sessionId }` for a DIFFERENT session (the
 * human's own tab, or a lease) saved a picture of the driven page and answered `saved: true`. The
 * launched provider photographs the one page it owns whatever url it is handed, and `capture()`
 * asked it first without checking that it owned the named session. `reticle_visual_diff` shares
 * `capture()`, so a baseline could be written from one page and compared against another.
 */

import { removeTempDir } from '@/machine/temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { InputMode, ReticleTool } from '@reticlehq/core';
import { TOOLS, type ToolDeps } from '@/surface/tools/tools.js';
import { BaselineStore } from '@/memory/project/baselines.js';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import { FlowStore } from '@/language/flows/flows.js';
import { ProjectStore } from '@/memory/project/project-store.js';
import { AnnotationStore } from '@/language/flows/stores/annotation-store.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import type { RealInputProvider } from '@/portal/input/real-input.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import type { BrowserPool } from '@/portal/pool/browser-pool.js';

const now = (): number => 0;
const DRIVEN = { id: 'driven', url: 'http://localhost:3000/' } as Session;
const OTHER = { id: 'other', url: 'http://localhost:3000/trade' } as Session;

function solidPng(rgb: [number, number, number]): Uint8Array {
  const png = new PNG({ width: 6, height: 6 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgb[0];
    png.data[i + 1] = rgb[1];
    png.data[i + 2] = rgb[2];
    png.data[i + 3] = 255;
  }
  return new Uint8Array(PNG.sync.write(png));
}

const DRIVEN_PIXELS = solidPng([255, 0, 0]);
const OTHER_PIXELS = solidPng([0, 0, 255]);

/** Owns the driven page and, like the launched provider, photographs it whatever url it is given. */
const drivingProvider: RealInputProvider = {
  isAvailableFor: (url) => Promise.resolve(url === DRIVEN.url),
  perform: () =>
    Promise.resolve({ performed: false, center: { cx: 0, cy: 0 }, inputMode: InputMode.REAL }),
  screenshot: () => Promise.resolve(DRIVEN_PIXELS),
};

/** The other session is a lease, which has its own route to its own pixels. */
const leasePool = {
  screenshotLease: (id: string) => Promise.resolve(id === OTHER.id ? OTHER_PIXELS : undefined),
} as unknown as BrowserPool;

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
}

describe('a screenshot is of the session it names', () => {
  let root: string;

  beforeEach(async () => {
    root = join(await mkdtemp(join(tmpdir(), 'reticle-vs-')), '.reticle');
  });

  afterEach(async () => {
    await removeTempDir(join(root, '..'));
  });

  function deps(extra: { realInput?: RealInputProvider; pool?: BrowserPool }): ToolDeps {
    const fs = createNodeFileSystem();
    const sessions: Partial<SessionManager> = {
      resolve: (id?: string) => (id === OTHER.id ? OTHER : DRIVEN),
    };
    return {
      sessions: sessions as SessionManager,
      baselines: new BaselineStore(),
      recordings: new RecordingStore(),
      flows: new FlowStore(fs, root, { now }),
      project: new ProjectStore(fs, root, { now }),
      annotations: new AnnotationStore(),
      fs,
      reticleRoot: root,
      now,
      ...extra,
    };
  }

  it('the driven session still gets the provider', async () => {
    const r = (await tool(ReticleTool.SCREENSHOT).handler(deps({ realInput: drivingProvider }), {
      name: 'home',
      sessionId: DRIVEN.id,
    })) as { saved?: boolean; path: string };
    expect(r.saved).toBe(true);
    expect(new Uint8Array(await readFile(r.path))).toEqual(DRIVEN_PIXELS);
  });

  it("another session gets its own pixels through the lease, never the driven tab's", async () => {
    const r = (await tool(ReticleTool.SCREENSHOT).handler(
      deps({ realInput: drivingProvider, pool: leasePool }),
      { name: 'trade', sessionId: OTHER.id },
    )) as { saved?: boolean; path: string };
    expect(r.saved).toBe(true);
    expect(new Uint8Array(await readFile(r.path))).toEqual(OTHER_PIXELS);
  });

  it('another session with no route of its own is refused, not saved', async () => {
    const r = (await tool(ReticleTool.SCREENSHOT).handler(deps({ realInput: drivingProvider }), {
      name: 'trade',
      sessionId: OTHER.id,
    })) as { ok?: boolean; saved?: boolean };
    expect(r.saved).toBeUndefined();
    expect(r.ok).toBe(false);
  });

  it('reticle_visual_diff compares the named session, not the driven tab', async () => {
    // Baseline taken from the other session's own pixels, with nothing driving.
    await tool(ReticleTool.SCREENSHOT).handler(deps({ pool: leasePool }), {
      name: 'trade',
      sessionId: OTHER.id,
    });
    const r = (await tool(ReticleTool.VISUAL_DIFF).handler(
      deps({ realInput: drivingProvider, pool: leasePool }),
      { baseline: 'trade', sessionId: OTHER.id },
    )) as { matched?: boolean; changedPixels?: number };
    expect(r.matched, "a diff against the driven tab's pixels reads as a regression").toBe(true);
    expect(r.changedPixels).toBe(0);
  });

  it('reticle_visual_diff with no route for the other session is refused, not compared', async () => {
    await tool(ReticleTool.SCREENSHOT).handler(deps({ pool: leasePool }), {
      name: 'trade',
      sessionId: OTHER.id,
    });
    const r = (await tool(ReticleTool.VISUAL_DIFF).handler(deps({ realInput: drivingProvider }), {
      baseline: 'trade',
      sessionId: OTHER.id,
    })) as { ok?: boolean; matched?: boolean };
    expect(r.ok).toBe(false);
    expect(r.matched).toBeUndefined();
  });
});
