/**
 * The durable bit has to reach the two places that make the claim, or it is a file nobody reads.
 *
 * Both the prose diagnosis and the machine-readable `next_action` assert "this daemon has never seen
 * a session", and they must agree — the sibling strings were checked in the field report and the
 * claim appears in more than one of them.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NoSessionAction } from '@reticlehq/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rememberConnected } from './connection-memory.js';
import { nextActionFor } from './no-session-next-action.js';
import { startNoSessionWatch } from './no-session-watch.js';
import { SessionManager } from './session-manager.js';

describe('next_action agrees with the prose about a restarted daemon', () => {
  it('does not send a proven-connected project back through init', () => {
    const next = nextActionFor({
      everConnected: false,
      previouslyConnected: true,
      // The monorepo shape: the daemon stands where there is no `.reticle.json`, which is exactly
      // the case that used to produce "run reticle init" at a project that had already connected.
      initialized: false,
      listening: [3000],
      dev: undefined,
    });
    expect(next.action).not.toBe(NoSessionAction.RUN_INIT);
    expect(next.command).not.toBe('reticle init');
  });

  it('still sends a genuinely unwired project through init', () => {
    const next = nextActionFor({
      everConnected: false,
      previouslyConnected: false,
      initialized: false,
      listening: [3000],
      dev: undefined,
    });
    expect(next.action).toBe(NoSessionAction.RUN_INIT);
  });
});

describe('the watch reads the durable bit and hands it to the diagnosis', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reticle-watch-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('softens "never seen one" when the state directory records a prior connection', () => {
    const sessions = new SessionManager();
    // A NAMED project. The memory can also answer the weaker per-port question, but the watch
    // deliberately refuses to spend that answer here — see connectedBefore.
    writeFileSync(join(dir, '.reticle.json'), JSON.stringify({ projectId: 'app-abc' }), 'utf8');
    rememberConnected(dir, 4400, 'app-abc');
    const stop = startNoSessionWatch({
      sessions,
      port: 4400,
      initialized: true,
      directory: dir,
      stateDir: dir,
      probe: () => Promise.resolve([3000]),
      siblingProbe: () => [],
    });
    try {
      expect(sessions.noSessionHint() ?? '').not.toMatch(/never seen one/i);
    } finally {
      stop();
    }
  });

  it('keeps "never seen one" for a state directory that records nothing', () => {
    const sessions = new SessionManager();
    const stop = startNoSessionWatch({
      sessions,
      port: 4400,
      initialized: true,
      directory: dir,
      stateDir: dir,
      probe: () => Promise.resolve([]),
      siblingProbe: () => [],
    });
    try {
      expect(sessions.noSessionHint() ?? '').toMatch(/never seen one|no `\.reticle\.json`/i);
    } finally {
      stop();
    }
  });

  it('records a connection through the one method every session-registering path uses', () => {
    const sessions = new SessionManager();
    const seen: { port: number; projectId: string | undefined }[] = [];
    sessions.setConnectionRecorder((projectId) => {
      seen.push({ port: 4400, projectId });
    });
    sessions.add({
      id: 's1',
      projectId: 'app-abc',
      url: 'http://localhost:3000/',
      redactKeys: [],
    } as unknown as Parameters<SessionManager['add']>[0]);
    expect(seen).toEqual([{ port: 4400, projectId: 'app-abc' }]);
  });
});
