import { removeTempDir } from '../temp-dir.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventType, type ReticleEvent } from '@reticlehq/core';
import { createNodeFileSystem, type FileSystemPort } from '../project/fs-port.js';
import { makeJournalAttach, type JournalTarget } from './attach-journal.js';
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
