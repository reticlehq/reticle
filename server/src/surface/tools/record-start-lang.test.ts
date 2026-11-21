/**
 * A recording keeps the page language it started on (#2278).
 *
 * Replay can tell a page in another language from a page that lost an element only if the flow
 * says which language it was recorded in.
 */
import { describe, expect, it } from 'vitest';
import { ReticleTool } from '@reticlehq/core';
import { READ_TOOLS } from './read-tools.js';
import type { ToolDeps } from './tools.js';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';
import { notePageLanguage } from '@/portal/session/hello-identity.js';

const tool = (name: string) => {
  const t = READ_TOOLS.find((x) => x.name === name);
  if (t === undefined) {
    throw new Error(`no ${name}`);
  }
  return t;
};

function deps(session: Partial<Session>, recordings: RecordingStore): ToolDeps {
  return {
    sessions: { resolve: () => session as Session } as unknown as SessionManager,
    recordings,
  } as unknown as ToolDeps;
}

const page = {
  id: 's1',
  url: 'http://localhost:3000/cart',
  elapsed: () => 100,
  eventsSince: () => [],
};

async function recordOn(lang: string | undefined): Promise<{ startLang?: string }> {
  const session: Partial<Session> = { ...page };
  notePageLanguage(session, { lang });
  const recordings = new RecordingStore();
  await tool(ReticleTool.RECORD_START).handler(deps(session, recordings), {
    recordingName: 'trip',
  });
  const out = (await tool(ReticleTool.RECORD_STOP).handler(deps(session, recordings), {
    recordingName: 'trip',
  })) as { program: { startLang?: string } };
  return out.program;
}

describe('a recording keeps the page language', () => {
  it('saves the lang the page had when recording started', async () => {
    expect((await recordOn('en')).startLang).toBe('en');
  });

  it('saves no lang when the page sets none', async () => {
    expect(await recordOn(undefined)).not.toHaveProperty('startLang');
  });
});
