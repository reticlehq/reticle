/**
 * The first call that needs a page, on an app nobody wired, opens that app itself.
 *
 * The MCP-only install route never runs `init`, so the first page-needing call used to answer with
 * a diagnosis and the agent stopped there. The guards matter more than the happy path: a browser
 * opened on somebody else's app would produce a confident verdict about code nobody touched.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  firstCallOpener,
  projectAppUrlFinder,
  type FirstCallIo,
} from './zero-install-first-call.js';

const APP = mkdtempSync(join(tmpdir(), 'reticle-first-call-'));
writeFileSync(join(APP, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }), 'utf8');

/** An io where `serving` maps a listening port to the directory its server runs in. */
function io(
  serving: Record<number, string>,
  over: Partial<FirstCallIo> = {},
): FirstCallIo & { leased: string[] } {
  const leased: string[] = [];
  let connected = false;
  return {
    leased,
    project: () => APP,
    serving: (ports) => Promise.resolve(ports.filter((port) => serving[port] !== undefined)),
    servingDirectory: (url) => serving[Number(new URL(url).port)],
    lease: (url) => {
      leased.push(url);
      connected = true;
      return Promise.resolve({});
    },
    connected: () => connected,
    ...over,
  };
}

describe('firstCallOpener', () => {
  it("opens the one dev server running in this project's folder, and says what it did", async () => {
    const ports = io({ 5173: APP, 3000: '/somewhere/else' });
    const opened = await firstCallOpener(ports)();
    expect(ports.leased).toEqual(['http://localhost:5173']);
    expect(opened?.url).toBe('http://localhost:5173');
    // Honest about the tier, and hands over the command that makes it permanent.
    expect(opened?.notice).toMatch(/source file:line/);
    expect(opened?.notice).toContain('npx @reticlehq/server init');
    expect(opened?.notice).toMatch(/restart the dev server/i);
    // `init` changes the user's files, so the notice asks first, as every other offer of it does.
    expect(opened?.notice).toContain('Ask the user before you wire the app');
  });

  it('accepts a server running in a folder inside the project (a workspace app)', async () => {
    const ports = io({ 5173: join(APP, 'apps', 'web') });
    expect((await firstCallOpener(ports)())?.url).toBe('http://localhost:5173');
  });

  it("never opens a server it cannot attribute to this project — another repo's app", async () => {
    const ports = io({ 5173: '/another/repo' });
    expect(await firstCallOpener(ports)()).toBeUndefined();
    expect(ports.leased).toEqual([]);
  });

  it('never guesses between two of its own servers', async () => {
    const ports = io({ 5173: APP, 3000: APP });
    expect(await firstCallOpener(ports)()).toBeUndefined();
    expect(ports.leased).toEqual([]);
  });

  it('does nothing for a project that is wired, or is not a web app (no project)', async () => {
    const ports = io({ 5173: APP }, { project: () => undefined });
    expect(await firstCallOpener(ports)()).toBeUndefined();
    expect(ports.leased).toEqual([]);
  });

  it('tries one lease per project, never a loop', async () => {
    let attempts = 0;
    const open = firstCallOpener(
      io(
        { 5173: APP },
        {
          lease: () => {
            attempts += 1;
            return Promise.reject(new Error('no chromium'));
          },
        },
      ),
    );
    expect(await open()).toBeUndefined();
    expect(await open()).toBeUndefined();
    expect(attempts).toBe(1);
  });

  it('reports nothing opened when the lease came back without a session', async () => {
    const ports = io({ 5173: APP }, { connected: () => false });
    expect(await firstCallOpener(ports)()).toBeUndefined();
  });

  it('looks again on a later call when no server was up yet', async () => {
    let up = false;
    const ports = io({});
    const open = firstCallOpener({
      ...ports,
      serving: (candidates) => Promise.resolve(up ? candidates.filter((p) => 5173 === p) : []),
      servingDirectory: () => APP,
    });
    expect(await open()).toBeUndefined();
    up = true;
    expect((await open())?.url).toBe('http://localhost:5173');
  });
});

describe('projectAppUrlFinder', () => {
  it("names the one dev server in this project's folder, and opens nothing", async () => {
    const ports = io({ 5173: APP, 3000: '/somewhere/else' });
    expect(await projectAppUrlFinder(ports)()).toBe('http://localhost:5173');
    expect(ports.leased).toEqual([]);
  });

  it('names none when two servers run in the project', async () => {
    expect(await projectAppUrlFinder(io({ 5173: APP, 3000: APP }))()).toBeUndefined();
  });
});
