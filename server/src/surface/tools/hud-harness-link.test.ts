/**
 * Link this project, from the HUD's Harness page: the panel used to say "Not linked: run `reticle
 * connect`", a dead end for anybody not in a terminal. The daemon now links the project of the tab
 * that asked, and says the result on that tab.
 */
import { EventType, HumanControlKind } from '@reticlehq/core';
import { describe, expect, it, vi } from 'vitest';
import { harnessRequest } from '../../portal/bridge/harness-request.js';
import type { ToolDeps } from './tool-kit.js';
import { attachHudHarness, projectLinkOnly } from './chat-drives.js';

const control = (kind: string) => ({ type: EventType.HUMAN_CONTROL, data: { kind } });

function wire(link?: (root: string) => Promise<number>) {
  let handler: ((request: never, s: { id: string; artifactRoot?: string }) => void) | undefined;
  const said: string[] = [];
  const repaint = vi.fn();
  const deps = {
    sessions: { get: () => ({ pushNarration: (text: string) => said.push(text) }) },
  } as unknown as ToolDeps;
  attachHudHarness(
    { attachHarnessRequest: (h) => (handler = h as typeof handler) },
    { deps: () => deps, root: '/daemon/cwd', repaint },
    vi.fn(),
    link,
  );
  const press = (artifactRoot?: string): void =>
    handler?.(harnessRequest(control(HumanControlKind.HARNESS_LINK)) as never, {
      id: 's1',
      ...(artifactRoot === undefined ? {} : { artifactRoot }),
    });
  return { press, said, repaint };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('Link this project, from the Harness page', () => {
  it('the bridge reads the control as a link request', () => {
    expect(harnessRequest(control(HumanControlKind.HARNESS_LINK))).toEqual({
      kind: HumanControlKind.HARNESS_LINK,
    });
  });

  it("links the tab's own project folder, not the daemon's, then says so and repaints", async () => {
    const link = vi.fn(() => Promise.resolve(0));
    const { press, said, repaint } = wire(link);
    press('/work/shop');
    await settle();
    expect(link).toHaveBeenCalledWith('/work/shop');
    expect(said).toEqual(['Linked. This project now reports to your dashboard.']);
    expect(repaint).toHaveBeenCalled();
  });

  it('a failed link says so and names the command that works', async () => {
    const { press, said } = wire(() => Promise.resolve(1));
    press('/work/shop');
    await settle();
    expect(said[0]).toMatch(/Could not link this project\. Run `reticle connect`/);
  });

  it('a daemon that cannot link says so instead of doing nothing', () => {
    const { press, said } = wire(undefined);
    press('/work/shop');
    expect(said[0]).toMatch(/cannot link from the panel/);
  });

  /**
   * A hand-wired SDK with no projectId linked a project named "origin-c97c5ca3", bound to a folder
   * under ~/.reticle/unmatched that the panel never reads, so the button seemed to do nothing. It
   * asks once for what it needs instead.
   */
  it('a page that never said which project it is gets asked for one, not a hash-named link', () => {
    const link = vi.fn(() => Promise.resolve(0));
    const { press, said } = wire(link);
    press('/home/u/.reticle/unmatched/origin-c97c5ca3');
    expect(link).not.toHaveBeenCalled();
    expect(said[0]).toMatch(/projectId/);
    expect(said[0]).toMatch(/init/);
  });

  it('a sign-in from a page with no project links nothing', async () => {
    const link = vi.fn(() => Promise.resolve(0));
    const onSignIn = projectLinkOnly(link);
    await onSignIn?.('/home/u/.reticle/unmatched/origin-c97c5ca3');
    await onSignIn?.('/work/shop/.reticle');
    expect(link.mock.calls).toEqual([['/work/shop/.reticle']]);
  });
});
