import { describe, expect, it } from 'vitest';
import { DriveMode, DriveTarget, HudVisibility, SpecIgnoredReason } from '@reticlehq/core';
import {
  HUD_ATTEMPTS,
  NO_ADDRESS_TO_OPEN,
  prepareDrive,
  type DriveTargetPorts,
} from './drive-target.js';

const ports = (over: Partial<DriveTargetPorts> = {}) => {
  const opened: [string, boolean, string | undefined][] = [];
  const tuned: [string, string][] = [];
  const all: DriveTargetPorts = {
    pickTab: () => Promise.resolve('tab-1'),
    open: (url, headed, hud) => {
      opened.push([url, headed, hud]);
      return Promise.resolve(headed ? 'lease-headed' : 'lease-headless');
    },
    tuneHud: (id, hud) => {
      tuned.push([id, hud]);
      return Promise.resolve();
    },
    sleep: () => Promise.resolve(),
    ...over,
  };
  return { all, opened, tuned };
};

describe('the tab a platform drive runs in', () => {
  it("is the person's own tab when nothing else is asked", async () => {
    const p = ports();
    expect(await prepareDrive({}, undefined, p.all)).toEqual({
      sessionId: 'tab-1',
      applied: { target: DriveTarget.TAB, mode: DriveMode.LOCAL, sessionId: 'tab-1' },
      ignored: [],
    });
    expect(p.opened).toEqual([]);
  });

  it('opens a window at the address asked for, with the HUD as asked', async () => {
    const p = ports();
    const prepared = await prepareDrive(
      { target: 'headed', hud: 'removed', url: 'http://localhost:3000/cart', mode: 'platform' },
      'http://localhost:3000/',
      p.all,
    );
    expect(p.opened).toEqual([['http://localhost:3000/cart', true, 'removed']]);
    expect(p.tuned).toEqual([['lease-headed', 'removed']]);
    expect(prepared.applied).toEqual({
      target: DriveTarget.HEADED,
      mode: DriveMode.PLATFORM,
      url: 'http://localhost:3000/cart',
      hud: HudVisibility.REMOVED,
      sessionId: 'lease-headed',
    });
  });

  it('falls back to no window when a window cannot open, and says why', async () => {
    const p = ports({
      open: (_url, headed) =>
        headed ? Promise.reject(new Error('no display')) : Promise.resolve('lease-headless'),
    });
    const prepared = await prepareDrive({ target: 'headed' }, 'http://localhost:3000/', p.all);
    expect(prepared.sessionId).toBe('lease-headless');
    expect(prepared.applied.target).toBe(DriveTarget.HEADLESS);
    expect(prepared.ignored).toEqual([
      { field: 'target', reason: SpecIgnoredReason.UNAVAILABLE, detail: 'no display' },
    ]);
  });

  it('refuses a browser of its own with nowhere to point it', async () => {
    const prepared = await prepareDrive({ target: 'headless' }, undefined, ports().all);
    expect(prepared.sessionId).toBeNull();
    expect(prepared.refusal).toBe(NO_ADDRESS_TO_OPEN);
  });

  it('asks for the HUD until the page takes it, and reports a page that never does', async () => {
    let tries = 0;
    const slow = ports({
      tuneHud: () => {
        tries += 1;
        return tries < 3 ? Promise.reject(new Error('no HUD yet')) : Promise.resolve();
      },
    });
    expect((await prepareDrive({ hud: 'hidden' }, undefined, slow.all)).applied.hud).toBe(
      HudVisibility.HIDDEN,
    );
    const never = ports({ tuneHud: () => Promise.reject(new Error('an older SDK')) });
    const prepared = await prepareDrive({ hud: 'hidden' }, undefined, never.all);
    expect(prepared.applied.hud).toBeUndefined();
    expect(prepared.ignored).toEqual([
      { field: 'hud', reason: SpecIgnoredReason.UNAVAILABLE, detail: 'an older SDK' },
    ]);
    expect(HUD_ATTEMPTS).toBeGreaterThan(1);
  });
});
