import { removeTempDir } from '../temp-dir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { createNodeFileSystem, type FileSystemPort } from '../project/fs-port.js';
import { makeJournalAttach, type JournalTarget } from './attach-journal.js';
import * as logModule from '../log.js';
import type { JournalRecorder } from './journal-recorder.js';

/** Minimal Session stand-in: records whether a recorder was attached and drives its elapsed clock. */
function target(id: string): JournalTarget & { recorder?: JournalRecorder } {
  let t = 0;
  return {
    id,
    elapsed: () => t++,
    setJournal(recorder) {
      this.recorder = recorder;
    },
  };
}

describe('makeJournalAttach', () => {
  let root: string;
  let fs: FileSystemPort;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reticle-attach-'));
    root = join(dir, '.reticle');
    fs = createNodeFileSystem();
  });

  afterEach(async () => {
    await removeTempDir(join(root, '..'));
  });

  it('attaches a recorder that journals events to disk for a valid session', async () => {
    const attach = makeJournalAttach({ fs, reticleRoot: root, enabled: true });
    const s = target('demo');
    attach(s);
    expect(s.recorder).toBeDefined();
    const evt: ReticleEvent = {
      t: 0,
      seq: 0,
      type: EventType.DOM_ADDED,
      sessionId: 'demo',
      data: {},
    };
    s.recorder?.observe(evt);
    await s.recorder?.flush();
    const text = await readFile(join(root, 'sessions', 'demo', 'events.jsonl'), 'utf8');
    expect(text).toContain('"seq":0');
  });

  it('does not attach when journaling is disabled', () => {
    const s = target('demo');
    makeJournalAttach({ fs, reticleRoot: root, enabled: false })(s);
    expect(s.recorder).toBeUndefined();
  });

  it('skips (never throws) on an unsafe session id instead of crashing the session', () => {
    const s = target('../escape');
    expect(() => makeJournalAttach({ fs, reticleRoot: root, enabled: true })(s)).not.toThrow();
    expect(s.recorder).toBeUndefined();
  });
});

/**
 * A session whose id is not a safe path segment cannot be journalled — the id becomes a directory
 * name. The guard holds and nothing escapes the workspace, which is precisely why the failure was
 * invisible: the session connects, drives, and answers tools normally, and the only difference is
 * that its durable record does not exist. Every query reading back through the journal returns
 * nothing, and nothing says why.
 */
describe('a session that cannot be journalled says so', () => {
  it('does not attach a journal for an unsafe id, and leaves a line about it', () => {
    const lines: unknown[] = [];
    const spy = vi.spyOn(logModule, 'log').mockImplementation((event, fields) => {
      lines.push({ event, fields });
    });
    const attach = makeJournalAttach({
      fs: createNodeFileSystem(),
      reticleRoot: '/w/.reticle',
      enabled: true,
    });

    let attached = false;
    attach({
      id: '../../../tmp/pwned',
      elapsed: () => 0,
      setJournal: () => {
        attached = true;
      },
    });

    expect(attached, 'an unsafe id must not become a directory name').toBe(false);
    expect(JSON.stringify(lines)).toContain('journal_skipped_unsafe_session_id');
    spy.mockRestore();
  });

  it('still attaches for an ordinary id', () => {
    const attach = makeJournalAttach({
      fs: createNodeFileSystem(),
      reticleRoot: '/w/.reticle',
      enabled: true,
    });
    let attached = false;
    attach({ id: 'next-smoke', elapsed: () => 0, setJournal: () => (attached = true) });
    expect(attached).toBe(true);
  });
});
