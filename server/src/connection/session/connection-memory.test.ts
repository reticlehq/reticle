/**
 * "This daemon has never seen a session" is a claim about a PROCESS, and it was being reported as a
 * claim about the install.
 *
 * `SessionManager.everConnected()` is a per-process boolean. A daemon that idles out and is
 * respawned seconds later says it has never seen a session about a project whose app connected to
 * its predecessor a minute ago — and the diagnosis built on it then sends the reader hunting a
 * `.reticle.json` that was never missing. Reported repeatedly from the field.
 *
 * The fix is one durable bit per port + project. These tests pin that bit, and pin that a
 * fresh-install state is still reported as a fresh install: "never seen one" has to keep meaning
 * what it says, or the replacement is just a differently-wrong claim.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hasConnectedBefore,
  hasProjectConnectedBefore,
  rememberConnected,
} from './connection-memory.js';

describe('connection memory', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reticle-conn-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports nothing before anything has ever connected', () => {
    expect(hasConnectedBefore(dir, 4400, 'app-abc')).toBe(false);
  });

  it('remembers a connection across processes, keyed on port and project', () => {
    rememberConnected(dir, 4400, 'app-abc');
    expect(hasConnectedBefore(dir, 4400, 'app-abc')).toBe(true);
  });

  it('does not claim a DIFFERENT project connected before', () => {
    rememberConnected(dir, 4400, 'app-abc');
    expect(hasConnectedBefore(dir, 4400, 'other-app')).toBe(false);
  });

  it('does not claim a different PORT saw the project', () => {
    rememberConnected(dir, 4400, 'app-abc');
    expect(hasConnectedBefore(dir, 4500, 'app-abc')).toBe(false);
  });

  it('remembers an untagged session per port, for an SDK that stamps no projectId', () => {
    rememberConnected(dir, 4400, undefined);
    expect(hasConnectedBefore(dir, 4400, undefined)).toBe(true);
  });

  it('a project that connected also satisfies an untagged query on the same port', () => {
    rememberConnected(dir, 4400, 'app-abc');
    expect(hasConnectedBefore(dir, 4400, undefined)).toBe(true);
  });

  it('is idempotent and never grows without bound on repeated connects', () => {
    for (let i = 0; i < 50; i += 1) rememberConnected(dir, 4400, 'app-abc');
    expect(hasConnectedBefore(dir, 4400, 'app-abc')).toBe(true);
  });

  it('survives a corrupt state file rather than throwing at the diagnosis', () => {
    writeFileSync(join(dir, 'connected-4400.json'), 'not json at all', 'utf8');
    expect(hasConnectedBefore(dir, 4400, 'app-abc')).toBe(false);
    rememberConnected(dir, 4400, 'app-abc');
    expect(hasConnectedBefore(dir, 4400, 'app-abc')).toBe(true);
  });

  it('never throws when the state directory cannot be written', () => {
    expect(() => {
      rememberConnected(join(dir, 'nope', 'deeper'), 4400, 'app-abc');
    }).not.toThrow();
  });
});

/**
 * The first-move instructions make a claim about a PROJECT — "no app has ever connected to Reticle
 * in this project" — and were deciding it with the weaker per-PORT question.
 *
 * An unwired project has no `.reticle.json`, therefore no projectId, therefore fell into the
 * untagged branch, which answers "has ANY app connected on this port". On any machine where the
 * default port has ever served anything, that is true — so the guidance was suppressed for exactly
 * the person it was written for, and their agent was told the setup was done.
 *
 * `hasConnectedBefore` keeps the weaker reading on purpose: the no-session diagnosis genuinely wants
 * "has this daemon ever served an app", and answering "no" there would be the over-confident claim
 * that file exists to remove. The two questions are different, so they are two functions.
 */
describe('the first-move question is about the project, not the port', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reticle-firstmove-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('holds that nothing connected here when this project has no identity yet', () => {
    rememberConnected(dir, 4400, 'some-other-app');
    // The weaker question is still honestly true — a daemon on this port HAS served an app.
    expect(hasConnectedBefore(dir, 4400, undefined)).toBe(true);
    // But not for this project, which is what the instructions claim.
    expect(hasProjectConnectedBefore(dir, 4400, undefined)).toBe(false);
  });

  it('still recognises a project that really has connected', () => {
    rememberConnected(dir, 4400, 'app-abc');
    expect(hasProjectConnectedBefore(dir, 4400, 'app-abc')).toBe(true);
  });

  it('does not let one project answer for another', () => {
    rememberConnected(dir, 4400, 'app-abc');
    expect(hasProjectConnectedBefore(dir, 4400, 'app-xyz')).toBe(false);
  });

  it('reports a fresh install as fresh', () => {
    expect(hasProjectConnectedBefore(dir, 4400, 'app-abc')).toBe(false);
    expect(hasProjectConnectedBefore(dir, 4400, undefined)).toBe(false);
  });
});
