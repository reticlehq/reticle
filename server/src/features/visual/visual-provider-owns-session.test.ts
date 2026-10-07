/**
 * A screenshot names a session, and only a provider driving that session's page may answer it
 * (#1407).
 *
 * While `reticle drive` was alive, `reticle_screenshot { sessionId }` for a DIFFERENT tab saved a
 * picture of the driven page and answered `saved: true`, because `capture()` called the provider
 * without asking whether it owned the session's page, and the launched provider ignores the url. A
 * baseline could be written from one page and diffed against another.
 */
import { removeTempDir } from '@/machine/temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { InputMode, VisualReason } from '@reticlehq/core';
import { ReticleTool } from '@reticlehq/core';
import { TOOLS, type ToolDeps } from '@/surface/tools/tools.js';
import { BaselineStore } from '@/memory/project/baselines.js';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import { FlowStore } from '@/language/flows/flows.js';
import { ProjectStore } from '@/memory/project/project-store.js';
import { AnnotationStore } from '@/language/flows/stores/annotation-store.js';
import { createNodeFileSystem, type FileSystemPort } from '@/memory/project/fs/fs-port.js';
import type { RealInputProvider } from '@/portal/input/real-input.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';

const now = (): number => 0;
const DRIVEN_URL = 'http://localhost:3000/';
const OTHER_TAB_URL = 'http://localhost:3000/trade';

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
const OTHER_TAB_PIXELS = solidPng([0, 0, 255]);

/** A launched provider: it owns the driven page and nothing else. */
function drivenProvider(shots: string[]): RealInputProvider {
  return {
    // The launched provider's rule: the query and hash are ignored.
    isAvailableFor: (url) => Promise.resolve(url.split(/[?#]/)[0] === DRIVEN_URL),
    perform: () =>
      Promise.resolve({ performed: false, center: { cx: 0, cy: 0 }, inputMode: InputMode.REAL }),
    screenshot: (url) => {
      shots.push(url);
      return Promise.resolve(DRIVEN_PIXELS);
    },
  };
}

describe('a screenshot is taken only by a provider that owns the named session', () => {
  let root: string;
  let fs: FileSystemPort;
  let shots: string[];

  beforeEach(async () => {
    root = join(await mkdtemp(join(tmpdir(), 'reticle-vt-own-')), '.reticle');
    fs = createNodeFileSystem();
    shots = [];
  });

  afterEach(async () => {
    await removeTempDir(join(root, '..'));
  });

  function deps(sessionUrl: string, lease?: Uint8Array, others: Session[] = []): ToolDeps {
    const session = { id: 'tab-b', url: sessionUrl } as Session;
    const sessions: Partial<SessionManager> = {
      resolve: () => session,
      all: () => [session, ...others],
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
      realInput: drivenProvider(shots),
      ...(lease === undefined
        ? {}
        : {
            pool: { screenshotLease: () => Promise.resolve(lease) } as unknown as ToolDeps['pool'],
          }),
    } as ToolDeps;
  }

  const screenshot = (d: ToolDeps) =>
    tool(ReticleTool.SCREENSHOT).handler(d, { name: 'trade', sessionId: 'tab-b' }) as Promise<{
      saved?: boolean;
      ok?: boolean;
      reason?: string;
      path?: string;
    }>;

  it("refuses for another tab rather than saving the driven page's pixels", async () => {
    const r = await screenshot(deps(OTHER_TAB_URL));

    expect(r.saved).not.toBe(true);
    expect(r.reason).toBe(VisualReason.NO_PROVIDER);
    expect(shots, 'the driven page must not be photographed for another tab').toEqual([]);
  });

  it("takes another tab's own pixels from its lease, never the driven page's", async () => {
    const r = await screenshot(deps(OTHER_TAB_URL, OTHER_TAB_PIXELS));

    expect(r.saved).toBe(true);
    expect(new Uint8Array(await readFile(r.path ?? ''))).toEqual(OTHER_TAB_PIXELS);
    expect(shots).toEqual([]);
  });

  it('diffs another tab against its own pixels, through the same route', async () => {
    const d = deps(OTHER_TAB_URL, OTHER_TAB_PIXELS);
    await screenshot(d);
    const r = (await tool(ReticleTool.VISUAL_DIFF).handler(d, {
      baseline: 'trade',
      sessionId: 'tab-b',
    })) as { matched?: boolean; changedPixels?: number };

    expect(r.matched).toBe(true);
    expect(r.changedPixels).toBe(0);
    expect(shots).toEqual([]);
  });

  // `isAvailableFor` ignores the query and hash, so a human tab on the driven page's url matches
  // too. Two sessions the provider would both answer for is ambiguity, refused rather than guessed.
  it("refuses a same-url tab rather than saving the driven page's pixels for it", async () => {
    const drivenTab = { id: 'driven', url: `${DRIVEN_URL}?__reticle_opened=1` } as Session;
    const r = await screenshot(deps(`${DRIVEN_URL}#top`, OTHER_TAB_PIXELS, [drivenTab]));

    expect(new Uint8Array(await readFile(r.path ?? ''))).toEqual(OTHER_TAB_PIXELS);
    expect(shots).toEqual([]);
  });

  it('still uses the provider for the session it is driving', async () => {
    const r = await screenshot(deps(DRIVEN_URL));

    expect(r.saved).toBe(true);
    expect(new Uint8Array(await readFile(r.path ?? ''))).toEqual(DRIVEN_PIXELS);
    expect(shots).toEqual([DRIVEN_URL]);
  });
});

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  return t;
}
