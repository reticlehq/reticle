import { describe, expect, it } from 'vitest';
import { isSameOrAbove, portForInit, portFromEnv } from './init-port.js';

const OTHER_PROJECT = 'shop-1234abcd';
const RELOCATED = 4401;

function deps(holder: string | undefined, present = true, others: readonly string[] = []) {
  return {
    daemonProjects: () => Promise.resolve(holder === undefined ? others : [holder, ...others]),
    daemonPresent: () => Promise.resolve(present),
    pickPort: () => Promise.resolve(RELOCATED),
  };
}

describe('portForInit', () => {
  it('keeps a port the person typed', async () => {
    expect(await portForInit(4999, undefined, undefined, deps(OTHER_PROJECT))).toBe(4999);
  });

  it('keeps the port this project already recorded', async () => {
    expect(await portForInit(undefined, 4471, undefined, deps(OTHER_PROJECT))).toBe(4471);
  });

  it('takes the default when nothing is listening there', async () => {
    expect(
      await portForInit(undefined, undefined, undefined, deps(OTHER_PROJECT, false)),
    ).toBeUndefined();
  });

  // A second project on one machine was wired to the first project's daemon, and the bridge
  // refused every connect from its app.
  it("moves a new project off the default when another project's daemon holds it", async () => {
    expect(await portForInit(undefined, undefined, undefined, deps(OTHER_PROJECT))).toBe(RELOCATED);
  });

  /**
   * Reported from a Tauri + Next app: the editor's MCP had started a daemon on the default port from
   * this very directory, before init wrote any project id. Init read that daemon as somebody else's,
   * moved the project to 4401, and the agent — whose MCP resolves its port once — never saw the app.
   */
  it('keeps the default when the daemon there was started from this project, id or no id', async () => {
    expect(
      await portForInit(undefined, undefined, undefined, {
        ...deps(OTHER_PROJECT),
        daemonStartedHere: () => true,
      }),
    ).toBeUndefined();
  });

  it('keeps the default when the daemon there is this project’s own', async () => {
    expect(
      await portForInit(undefined, undefined, OTHER_PROJECT, deps(OTHER_PROJECT)),
    ).toBeUndefined();
  });

  it('keeps the default when the daemon there claims no project', async () => {
    expect(await portForInit(undefined, undefined, undefined, deps(undefined))).toBeUndefined();
  });

  it('keeps the default when the daemon there serves several projects, which it accepts', async () => {
    expect(
      await portForInit(
        undefined,
        undefined,
        undefined,
        deps(OTHER_PROJECT, true, ['blog-9f00aa11']),
      ),
    ).toBeUndefined();
  });
});

/**
 * Every other command honours RETICLE_PORT; `init` read only `--port`, so a shell that exported it
 * got a project wired (and a daemon started) on the default while everything else it ran dialled
 * the exported port.
 */
describe('portFromEnv', () => {
  it('reads RETICLE_PORT, so init resolves the port the rest of the CLI does', () => {
    expect(portFromEnv({ RETICLE_PORT: '4455' })).toBe(4455);
  });

  it('is undefined when it is unset, empty or not a port', () => {
    expect(portFromEnv({})).toBeUndefined();
    expect(portFromEnv({ RETICLE_PORT: '' })).toBeUndefined();
    expect(portFromEnv({ RETICLE_PORT: 'abc' })).toBeUndefined();
    expect(portFromEnv({ RETICLE_PORT: '70000' })).toBeUndefined();
  });

  it('is written into the project exactly as an explicit port is', async () => {
    const explicit = portFromEnv({ RETICLE_PORT: '4455' });
    expect(await portForInit(explicit, 4471, undefined, deps(OTHER_PROJECT))).toBe(4455);
  });
});

describe('isSameOrAbove', () => {
  it('is the directory itself, or one it sits inside', () => {
    expect(isSameOrAbove('/work/app', '/work/app')).toBe(true);
    expect(isSameOrAbove('/work', '/work/app')).toBe(true);
    expect(isSameOrAbove('/work/app', '/work')).toBe(false);
    expect(isSameOrAbove('/work/ap', '/work/app')).toBe(false); // a prefix is not a parent
  });
});
