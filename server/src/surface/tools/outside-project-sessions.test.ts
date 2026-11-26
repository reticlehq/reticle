/**
 * A page reached through a port forward connects, and the list from another project never named it
 * (#2492).
 *
 * The page's project root is not on this machine. `reticle_session list` put every tab in one array
 * and said nothing about the project, so the connected page looked missing. The list now names that
 * tab under "connected, outside this project", with its url and project root. An id-less call still
 * refuses the tab. That refusal is the anti-cross-talk guard.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import {
  MessageKind,
  RETICLE_PROTOCOL_VERSION,
  ReticleTool,
  type HelloMessage,
} from '@reticlehq/core';
import { runWithClientDirectory } from '@/hooks/client-directory.js';
import { removeTempDirSync } from '@/machine/temp-dir.test-helpers.js';
import { Session } from '@/portal/session/session.js';
import { SessionManager } from '@/portal/session/session-manager.js';
import { OUTSIDE_PROJECT_HEADING } from './outside-project-sessions.js';
import type { ToolDeps } from './tool-kit.js';
import { TOOLS } from './tools.js';

const REMOTE_URL = 'http://localhost:13100/';
const LOCAL_PROJECT = 'local-app';
const REMOTE_PROJECT = 'remote-app';
const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) {
    removeTempDirSync(dir);
  }
});

const sessionsTool = TOOLS.find((tool) => ReticleTool.SESSIONS === tool.name);

function keep(dir: string): string {
  roots.push(dir);
  return dir;
}

/** A project directory with its own id, and a project root that is not created on disk. */
function projects(): { local: string; remoteRoot: string } {
  const local = keep(mkdtempSync(join(tmpdir(), 'reticle-2492-local-')));
  writeFileSync(join(local, '.reticle.json'), JSON.stringify({ projectId: LOCAL_PROJECT }));
  const holder = keep(mkdtempSync(join(tmpdir(), 'reticle-2492-remote-')));
  return { local, remoteRoot: join(holder, 'remote-app') };
}

function connected(remoteRoot: string): { sessions: SessionManager; tab: Session } {
  const hello: HelloMessage = {
    kind: MessageKind.HELLO,
    protocolVersion: RETICLE_PROTOCOL_VERSION,
    sessionId: 'remote-tab',
    projectId: REMOTE_PROJECT,
    url: REMOTE_URL,
    title: 'Remote',
    adapters: [],
    hasCapabilities: false,
  };
  const tab = new Session(hello, { send: (): void => undefined } as unknown as WebSocket, () => 0);
  // The evidence folder sits under a project directory this machine does not have.
  tab.artifactRoot = join(remoteRoot, '.reticle');
  const sessions = new SessionManager();
  sessions.setDefaultScope({ projectId: LOCAL_PROJECT });
  sessions.add(tab);
  return { sessions, tab };
}

interface Listed {
  sessions: { sessionId: string; projectId?: string }[];
  outside?: {
    heading: string;
    sessions: { sessionId: string; url: string; projectId?: string; projectRoot?: string }[];
  };
}

function listFrom(local: string, sessions: SessionManager): Promise<Listed> {
  if (sessionsTool === undefined) {
    throw new Error('reticle_sessions is not on the surface');
  }
  const deps = { sessions, reticleRoot: join(local, '.reticle') } as unknown as ToolDeps;
  return runWithClientDirectory(local, () => sessionsTool.handler(deps, {})) as Promise<Listed>;
}

describe('a connected page whose project is not this one', () => {
  it('names the page under the outside-project heading, with its url and project root', async () => {
    const { local, remoteRoot } = projects();
    expect(existsSync(remoteRoot)).toBe(false);
    const { sessions } = connected(remoteRoot);

    const result = await listFrom(local, sessions);

    expect(result.outside?.heading).toBe(OUTSIDE_PROJECT_HEADING);
    expect(result.outside?.sessions).toEqual([
      {
        sessionId: 'remote-tab',
        url: REMOTE_URL,
        projectId: REMOTE_PROJECT,
        projectRoot: remoteRoot,
      },
    ]);
    // The tab stays in the session list. The heading says why it is not this project.
    expect(result.sessions.some((row) => 'remote-tab' === row.sessionId)).toBe(true);
    // The anti-cross-talk refusal is unchanged: an id-less call does not take the foreign tab.
    expect(() => sessions.resolve()).toThrow(new RegExp(LOCAL_PROJECT));
  });

  it('uses the project root the page reported, even when evidence is filed elsewhere', async () => {
    const { local, remoteRoot } = projects();
    const { sessions, tab } = connected(remoteRoot);
    tab.projectRoot = remoteRoot;
    tab.artifactRoot = join(local, '.reticle');

    const result = await listFrom(local, sessions);

    expect(result.outside?.sessions[0]?.projectRoot).toBe(remoteRoot);
  });

  it('adds no outside section for a tab of the calling project', async () => {
    const { local } = projects();
    mkdirSync(join(local, '.reticle'));
    const { sessions, tab } = connected(local);
    tab.projectId = LOCAL_PROJECT as typeof tab.projectId;
    tab.artifactRoot = join(local, '.reticle');

    const result = await listFrom(local, sessions);

    expect(result.outside).toBeUndefined();
    expect(result.sessions.some((row) => 'remote-tab' === row.sessionId)).toBe(true);
  });
});
