/**
 * One daemon, two projects. A past session in the project the daemon was started in must not
 * become the answer for a different project that has never connected (#1465).
 *
 * The first `reticle_session` in that second project wires it and lists the files. The same call
 * from the first project still says to reopen the tab that was there.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import {
  MessageKind,
  NoSessionAction,
  RETICLE_PROTOCOL_VERSION,
  ReticleTool,
  type HelloMessage,
} from '@reticlehq/core';
import { runWithClientDirectory } from '@/hooks/client-directory.js';
import { TOOLS } from '@/surface/tools/tools.js';
import type { ToolDeps } from '@/surface/tools/tool-kit.js';
import { firstRunWiring, type RunCli } from './first-run-wiring.js';
import { Session } from './session.js';
import { SessionManager } from './session-manager.js';
import { startNoSessionWatch } from './no-session-watch.js';

const APP_A_URL = 'http://localhost:5173/orders';
const PLAN = [
  '  [✓] Vite plugin → vite.config.ts',
  '  [✓] Reticle config → .reticle.json',
  '{',
  '  "ok": true,',
  '  "url": "http://localhost:5174/"',
  '}',
].join('\n');

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Let the watch's port probe finish. One macrotask drains the promise chain; a loop would look like IO. */
async function settleProbe(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'reticle-second-'));
  roots.push(dir);
  return dir;
}

const sessionsTool = TOOLS.find((tool) => ReticleTool.SESSIONS === tool.name);

describe("a second project is not the first project's closed tab", () => {
  it('wires B on its first call, and still tells A to reopen A', async () => {
    const root = tempDir();
    const appA = join(root, 'a');
    const appB = join(root, 'b');
    const stateDir = join(root, 'state');
    mkdirSync(appA);
    mkdirSync(appB);
    mkdirSync(stateDir);
    writeFileSync(
      join(appA, '.reticle.json'),
      JSON.stringify({ projectId: 'app-a', framework: 'vite' }),
    );
    writeFileSync(
      join(appB, 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '6' } }),
    );

    const sessions = new SessionManager();
    const hello: HelloMessage = {
      kind: MessageKind.HELLO,
      protocolVersion: RETICLE_PROTOCOL_VERSION,
      sessionId: 'tab-a',
      projectId: 'app-a',
      url: APP_A_URL,
      title: 'A',
      adapters: [],
      hasCapabilities: false,
    };
    const tab = new Session(
      hello,
      { send: (): void => undefined } as unknown as WebSocket,
      () => 0,
    );
    sessions.add(tab);
    sessions.remove(tab);

    const wiredIn: string[] = [];
    const run: RunCli = (_args, cwd) => {
      wiredIn.push(cwd);
      const at = PLAN.indexOf('{');
      return Promise.resolve({ code: 0, stdout: PLAN.slice(at), stderr: PLAN.slice(0, at) });
    };
    const stop = startNoSessionWatch({
      sessions,
      port: 4400,
      initialized: true,
      directory: appA,
      stateDir,
      probe: () => Promise.resolve([5173]),
      routeStatus: () => Promise.resolve(undefined),
    });
    await settleProbe();

    const fromB = runWithClientDirectory(appB, () => sessions.noSessionNextAction());
    expect(fromB?.action).not.toBe(NoSessionAction.REOPEN_APP);
    expect(fromB?.command ?? '').not.toContain(APP_A_URL);

    if (sessionsTool === undefined) throw new Error('reticle_session is not on the surface');
    const deps = {
      sessions,
      reticleRoot: join(appA, '.reticle'),
      firstRun: firstRunWiring({ port: 4400, cliPath: 'reticle', run }),
    } as unknown as ToolDeps;
    const wired = (await runWithClientDirectory(appB, () => sessionsTool.handler(deps, {}))) as {
      wired?: { directory: string; steps: { target: string }[] };
      next_action?: { command?: string };
    };
    expect(wiredIn).toEqual([appB]);
    expect(wired.wired?.directory).toBe(appB);
    expect(wired.wired?.steps.map((step) => step.target)).toEqual([
      'vite.config.ts',
      '.reticle.json',
    ]);
    expect(JSON.stringify(wired)).not.toContain(APP_A_URL);

    const fromA = (await runWithClientDirectory(appA, () => sessionsTool.handler(deps, {}))) as {
      next_action?: { action: string; command?: string };
      wired?: unknown;
    };
    expect(fromA.wired).toBeUndefined();
    expect(fromA.next_action?.action).toBe(NoSessionAction.REOPEN_APP);
    expect(fromA.next_action?.command).toContain(APP_A_URL);

    stop();
  });

  it("reopens the caller's own url when that project has connected", async () => {
    const root = tempDir();
    const appA = join(root, 'a');
    const appB = join(root, 'b');
    const stateDir = join(root, 'state');
    mkdirSync(appA);
    mkdirSync(appB);
    mkdirSync(stateDir);
    writeFileSync(join(appA, '.reticle.json'), JSON.stringify({ projectId: 'app-a' }));
    writeFileSync(join(appB, '.reticle.json'), JSON.stringify({ projectId: 'app-b' }));
    const sessions = new SessionManager();
    const depart = (sessionId: string, projectId: string, url: string): void => {
      const tab = new Session(
        {
          kind: MessageKind.HELLO,
          protocolVersion: RETICLE_PROTOCOL_VERSION,
          sessionId,
          projectId,
          url,
          title: sessionId,
          adapters: [],
          hasCapabilities: false,
        },
        { send: (): void => undefined } as unknown as WebSocket,
        () => 0,
      );
      sessions.add(tab);
      sessions.remove(tab);
    };
    depart('tab-a', 'app-a', APP_A_URL);
    depart('tab-b', 'app-b', 'http://localhost:5174/inbox');
    const stop = startNoSessionWatch({
      sessions,
      port: 4400,
      initialized: true,
      directory: appA,
      stateDir,
      probe: () => Promise.resolve([5173, 5174]),
      routeStatus: () => Promise.resolve(undefined),
    });
    await settleProbe();

    const fromB = runWithClientDirectory(appB, () => sessions.noSessionNextAction());
    expect(fromB?.action).toBe(NoSessionAction.REOPEN_APP);
    expect(fromB?.command).toContain('http://localhost:5174/inbox');
    expect(fromB?.command ?? '').not.toContain(APP_A_URL);

    const fromA = runWithClientDirectory(appA, () => sessions.noSessionNextAction());
    expect(fromA?.action).toBe(NoSessionAction.REOPEN_APP);
    expect(fromA?.command).toContain(APP_A_URL);
    expect(fromA?.command ?? '').not.toContain('5174/inbox');

    stop();
  });
});
