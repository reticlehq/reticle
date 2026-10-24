import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReticleCommand, ScreenshotSource } from '@reticlehq/core';
import { removeTempDir } from '@/machine/temp-dir.js';
import { createNodeFileSystem } from '@/memory/project/fs/fs-port.js';
import { withShotRun } from '@/judgement/runs/default-run-id.js';
import { driveRunId } from '@/judgement/runs/drive-run.js';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';
import { readStepShots, shotsLanded } from '@/judgement/runs/artifact/run-store.js';
import { FRAME, filmNow, jpegSize, stopFilming, takeStepShot } from './step-shots.js';

/**
 * Every action leaves a picture of the page the moment its outcome was decided. The agent is handed
 * a PATH at once — never the image, and never a wait for the disk — and the file lands right after.
 */

/** The smallest JPEG `jpegSize` can read: SOI, one SOF0 frame header, EOI. */
function fakeJpeg(width: number, height: number, tag = 0): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    tag,
    0xff,
    0xd9,
  ]);
}

const dirs: string[] = [];
let tabs = 0;
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => removeTempDir(d)));
});

interface Fakes {
  render?: () => unknown;
  browser?: () => Uint8Array | undefined;
}

async function setup(fakes: Fakes): Promise<{ deps: ToolDeps; root: string; sessionId: string }> {
  const root = await mkdtemp(join(tmpdir(), 'step-shots-'));
  dirs.push(root);
  tabs += 1;
  const sessionId = `s${String(tabs)}`;
  const session = {
    id: sessionId,
    url: 'http://localhost:5173/',
    artifactRoot: root,
    isEnded: () => false,
    command: (name: string) => {
      if (name !== ReticleCommand.RENDER) return Promise.resolve({ ok: false, error: 'no' });
      const result = fakes.render?.();
      return Promise.resolve(
        result === undefined
          ? { ok: false, error: 'page does not serve render' }
          : { ok: true, result },
      );
    },
  };
  const deps = {
    fs: createNodeFileSystem(),
    reticleRoot: root,
    sessions: { resolve: () => session },
    ...(fakes.browser === undefined
      ? {}
      : {
          realInput: {
            isAvailableFor: () => Promise.resolve(true),
            screenshot: () => Promise.resolve(fakes.browser?.()),
          },
        }),
  } as unknown as ToolDeps;
  return { deps, root, sessionId };
}

const rendered = (bytes: Uint8Array) => () => ({
  ok: true,
  width: 8,
  height: 6,
  chunks: [Buffer.from(bytes).toString('base64')],
});

describe('takeStepShot', () => {
  it('names the path at once, then lands the file and its record under the drive run', async () => {
    const image = fakeJpeg(8, 6);
    const { deps, root, sessionId } = await setup({ render: rendered(image) });

    const shot = await takeStepShot(deps, sessionId, 'reticle_act');

    expect(shot).toEqual({
      path: join(root, 'visual', 'runs', driveRunId(sessionId), '0001-act.jpg'),
      source: ScreenshotSource.RENDERED,
    });
    await shotsLanded(root, driveRunId(sessionId));
    expect(new Uint8Array(await readFile('path' in shot ? shot.path : ''))).toEqual(image);
    expect(await readStepShots(deps.fs, root, driveRunId(sessionId))).toEqual([
      {
        seq: 1,
        file: '0001-act.jpg',
        tool: 'reticle_act',
        source: ScreenshotSource.RENDERED,
        width: 8,
        height: 6,
        sha256: createHash('sha256').update(image).digest('hex'),
      },
    ]);
  });

  it("names the action a verdict's picture was taken for, so the run can pair it", async () => {
    const { deps, root, sessionId } = await setup({ render: rendered(fakeJpeg(8, 6)) });
    Object.assign(deps.sessions.resolve(sessionId), { lastActionId: 'a7' });

    await takeStepShot(deps, sessionId, 'reticle_assert', { verdict: true });
    await shotsLanded(root, driveRunId(sessionId));

    const [shot] = await readStepShots(deps.fs, root, driveRunId(sessionId));
    expect(shot).toMatchObject({ verdict: true, actionId: 'a7' });
  });

  it('takes a real browser screenshot when the tab has one, and numbers each step', async () => {
    const { deps, root, sessionId } = await setup({
      browser: () => fakeJpeg(1280, 720),
      render: rendered(fakeJpeg(8, 6)),
    });

    const first = await takeStepShot(deps, sessionId, 'reticle_act_and_wait');
    const second = await takeStepShot(deps, sessionId, 'reticle_assert');

    expect(first).toMatchObject({ source: ScreenshotSource.BROWSER });
    expect('path' in second ? second.path.endsWith('0002-assert.jpg') : false).toBe(true);
    await shotsLanded(root, driveRunId(sessionId));
    const shots = await readStepShots(deps.fs, root, driveRunId(sessionId));
    expect(shots.map((s) => [s.file, s.width, s.height])).toEqual([
      ['0001-act_and_wait.jpg', 1280, 720],
      ['0002-assert.jpg', 1280, 720],
    ]);
  });

  it('falls back to drawing the page when the browser capture fails, and records which', async () => {
    const { deps, root, sessionId } = await setup({
      browser: () => undefined,
      render: rendered(fakeJpeg(8, 6)),
    });

    await takeStepShot(deps, sessionId, 'reticle_act');
    await shotsLanded(root, driveRunId(sessionId));

    const [shot] = await readStepShots(deps.fs, root, driveRunId(sessionId));
    expect(shot?.source).toBe(ScreenshotSource.RENDERED);
    // The next prediction follows what actually worked.
    expect(await takeStepShot(deps, sessionId, 'reticle_act')).toMatchObject({
      source: ScreenshotSource.RENDERED,
    });
  });

  /*
   * From a persona drive: the first recorded act had no screenshot — its path was named, but the
   * file never landed (shots.jsonl started at 2). The first capture of a tab is the one nothing has
   * vouched for yet (the in-page renderer loads on first use), so it is waited for, tried again
   * once, and the answer is a path that landed or the reason it did not.
   */
  it('makes the first capture of a fresh tab land, trying again once', async () => {
    let calls = 0;
    const image = fakeJpeg(8, 6);
    const { deps, root, sessionId } = await setup({
      render: () => {
        calls += 1;
        return 1 === calls ? undefined : rendered(image)();
      },
    });
    const first = await takeStepShot(deps, sessionId, 'reticle_act');
    expect(first).toMatchObject({ source: ScreenshotSource.RENDERED });
    expect(new Uint8Array(await readFile('path' in first ? first.path : ''))).toEqual(image);
    expect((await readStepShots(deps.fs, root, driveRunId(sessionId))).map((s) => s.seq)).toEqual([
      1,
    ]);
  });

  it('says why when no picture could be taken, rather than leaving the field out', async () => {
    const { deps, root, sessionId } = await setup({});

    // The first capture of a tab is waited for, so its answer is the reason already.
    const first = await takeStepShot(deps, sessionId, 'reticle_act');
    expect('error' in first ? first.error : '').toContain('render');
    await shotsLanded(root, driveRunId(sessionId));

    // Nothing worked last time, so this one waits for the capture and reports what happened.
    const answer = await takeStepShot(deps, sessionId, 'reticle_act');
    expect('error' in answer ? answer.error : '').toContain('render');
    expect(await readStepShots(deps.fs, root, driveRunId(sessionId))).toEqual([]);
  });

  it('sets pending: true on the fast path so callers know the file may not be on disk yet', async () => {
    // The first capture is always waited for. On subsequent captures the path is returned while
    // the write is still in flight — pending: true signals that the file may not exist yet.
    const { deps, sessionId } = await setup({ render: rendered(fakeJpeg(8, 6)) });

    // First capture: no prior source vouched for, so the file lands before the result returns.
    const first = await takeStepShot(deps, sessionId, 'reticle_act');
    expect('pending' in first ? first.pending : undefined).toBeUndefined();

    // Second capture: prediction kicks in (fast path), so the result returns before the file lands.
    const second = await takeStepShot(deps, sessionId, 'reticle_act');
    expect('path' in second && second.pending).toBe(true);
  });

  it('files a replay step under the run being verified, with the step it belongs to', async () => {
    const { deps, root, sessionId } = await setup({ render: rendered(fakeJpeg(8, 6)) });

    const shot = await withShotRun('run-1', () =>
      takeStepShot(deps, sessionId, 'reticle_replay', { step: 'checkout#2' }),
    );

    expect(shot).toMatchObject({ path: join(root, 'visual', 'runs', 'run-1', '0001-replay.jpg') });
    await shotsLanded(root, 'run-1');
    expect(await readStepShots(deps.fs, root, 'run-1')).toMatchObject([{ step: 'checkout#2' }]);
  });
});

describe('jpegSize', () => {
  it('reads the frame size, and refuses bytes that are not a JPEG', () => {
    expect(jpegSize(fakeJpeg(1600, 900))).toEqual({ width: 1600, height: 900 });
    expect(jpegSize(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });
});

/**
 * A run had a picture per step and nothing between them, so the cloud replay jumped from one step
 * to the next. A tab Reticle drives is now filmed about once a second into the same run, as `frame`
 * shots, and a frame budget keeps a long run under the platform's per-run limit.
 */
/** Hundreds of real file writes: a generous ceiling for a slow runner, never a duration assertion. */
const FRAME_BUDGET_TIMEOUT_MS = 60_000;

describe('frames between steps', () => {
  afterEach(() => {
    for (let i = 0; i <= tabs; i += 1) stopFilming(`s${String(i)}`);
  });

  it('films a driven tab into the run of its last step, and skips a page that did not change', async () => {
    let n = 0;
    const { deps, root, sessionId } = await setup({
      browser: () => fakeJpeg(8, 6, Math.floor(n++ / 2)),
    });
    await takeStepShot(deps, sessionId, 'reticle_act');
    await filmNow(sessionId);
    await filmNow(sessionId);
    await filmNow(sessionId);
    await shotsLanded(root, driveRunId(sessionId));
    const shots = await readStepShots(deps.fs, root, driveRunId(sessionId));
    expect(shots.map((s) => s.tool)).toEqual(['reticle_act', FRAME.TOOL, FRAME.TOOL]);
    expect(shots.map((s) => s.file)).toEqual(['0001-act.jpg', '0002-frame.jpg', '0003-frame.jpg']);
  });

  // A blinking caret made every tick a "new" frame: 16 frames held 2 distinct images.
  it('keeps a page that flips between two looks once per look, not once per tick', async () => {
    let n = 0;
    const { deps, root, sessionId } = await setup({ browser: () => fakeJpeg(8, 6, n++ % 2) });
    await takeStepShot(deps, sessionId, 'reticle_act');
    for (let i = 0; i < 20; i += 1) await filmNow(sessionId);
    await shotsLanded(root, driveRunId(sessionId));
    const shots = await readStepShots(deps.fs, root, driveRunId(sessionId));
    expect(shots.filter((s) => FRAME.TOOL === s.tool).length).toBeLessThanOrEqual(2);
  });

  // An unchanged page was captured every second for the life of the session, then thrown away.
  it('captures an unchanged page less and less often', async () => {
    let captures = 0;
    const { deps, sessionId } = await setup({
      browser: () => {
        captures += 1;
        return fakeJpeg(8, 6, 1);
      },
    });
    await takeStepShot(deps, sessionId, 'reticle_act');
    const afterStep = captures;
    for (let i = 0; i < 64; i += 1) await filmNow(sessionId);
    expect(captures - afterStep).toBeLessThanOrEqual(8);
  });

  it('films nothing on a tab Reticle does not drive', async () => {
    const { deps, root, sessionId } = await setup({ render: rendered(fakeJpeg(8, 6)) });
    await takeStepShot(deps, sessionId, 'reticle_act');
    await filmNow(sessionId);
    await shotsLanded(root, driveRunId(sessionId));
    const shots = await readStepShots(deps.fs, root, driveRunId(sessionId));
    expect(shots.map((s) => s.tool)).toEqual(['reticle_act']);
  });

  it(
    'keeps at most the frame budget in one run, and the steps still get their pictures',
    async () => {
      let n = 0;
      const { deps, root, sessionId } = await setup({ browser: () => fakeJpeg(8, 6, n++ % 250) });
      await takeStepShot(deps, sessionId, 'reticle_act');
      for (let i = 0; i < 2_000; i += 1) await filmNow(sessionId);
      await takeStepShot(deps, sessionId, 'reticle_act');
      await shotsLanded(root, driveRunId(sessionId));
      const shots = await readStepShots(deps.fs, root, driveRunId(sessionId));
      expect(shots.filter((s) => FRAME.TOOL === s.tool)).toHaveLength(FRAME.MAX_PER_RUN);
      expect(shots.filter((s) => 'reticle_act' === s.tool)).toHaveLength(2);
    },
    FRAME_BUDGET_TIMEOUT_MS,
  );
});
