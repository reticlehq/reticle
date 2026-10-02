import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NOTICE_MEMORY_BASENAME,
  noticeKey,
  readSaid,
  rememberSaid,
  unsaidNotices,
} from './agent-notice-memory.js';

const ZED = {
  name: 'Zed',
  file: '/h/.config/zed/settings.json',
  why: 'a different entry is there',
};
const CONTINUE = { name: 'Continue', file: '/h/.continue/config.yaml', why: 'its config is YAML' };

describe('unsaidNotices', () => {
  it('says everything the first time', () => {
    expect(unsaidNotices([], [ZED, CONTINUE])).toEqual([ZED, CONTINUE]);
  });

  it('says nothing the second time', () => {
    expect(unsaidNotices([ZED, CONTINUE].map(noticeKey), [ZED, CONTINUE])).toEqual([]);
  });

  it('says it again when the reason changes, because that is a different fact', () => {
    const changed = { ...ZED, why: 'its config is not plain JSON' };
    expect(unsaidNotices([noticeKey(ZED)], [changed])).toEqual([changed]);
  });

  it('does not repeat one notice listed twice in a single run', () => {
    expect(unsaidNotices([], [ZED, ZED])).toEqual([ZED]);
  });
});

describe('the stamp on disk', () => {
  it('round-trips, and merges rather than truncating', () => {
    const home = mkdtempSync(join(tmpdir(), 'reticle-notice-'));
    try {
      rememberSaid(home, [noticeKey(ZED)]);
      rememberSaid(home, [noticeKey(CONTINUE)]);
      expect(readSaid(home).sort()).toEqual([noticeKey(ZED), noticeKey(CONTINUE)].sort());
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reads a corrupt stamp as nothing said, so the notice prints rather than vanishing', () => {
    const home = mkdtempSync(join(tmpdir(), 'reticle-notice-'));
    try {
      writeFileSync(join(home, NOTICE_MEMORY_BASENAME), 'not json at all');
      expect(readSaid(home)).toEqual([]);
      expect(unsaidNotices(readSaid(home), [ZED])).toEqual([ZED]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reads a missing stamp as nothing said', () => {
    expect(readSaid(join(tmpdir(), 'reticle-no-such-dir-at-all'))).toEqual([]);
  });
});
