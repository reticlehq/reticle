import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runDrivenBy } from '@/hooks/driven-by.js';
import { logToolCall } from './tool-log.js';

describe('the tool log', () => {
  it('appends each call with what it asked, what it got, and who drove it', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tool-log-')), 'calls.jsonl');
    logToolCall(path, {
      tool: 'reticle_look',
      args: { action: 'page' },
      at: 1,
      ms: 2,
      result: { ok: 1 },
    });
    await runDrivenBy({ harness: 'h1', driver: 'jev' }, () => {
      logToolCall(path, { tool: 'reticle_act', args: {}, at: 3, ms: 4, error: 'no session' });
      return Promise.resolve();
    });
    const lines = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({
      tool: 'reticle_look',
      args: { action: 'page' },
      result: { ok: 1 },
    });
    expect(lines[0]?.['drivenBy']).toBeUndefined();
    expect(lines[1]).toMatchObject({
      tool: 'reticle_act',
      error: 'no session',
      drivenBy: { harness: 'h1' },
    });
  });
});
