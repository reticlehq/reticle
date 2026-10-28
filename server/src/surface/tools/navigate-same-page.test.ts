/**
 * The document a same-URL navigation starts FROM must be sampled before dispatch.
 *
 * `reticle_navigate` to the page already shown replaces the document. The replacement can connect
 * while the NAVIGATE reply is still pending, so reading `currentDocumentId` after the await records
 * the REPLACEMENT as the starting document — the scan then skips it on every poll and reports a
 * successful navigation as `confirmed:false`.
 */

import { describe, expect, it } from 'vitest';
import { BROWSER_TOOLS } from './browser-tools.js';
import { ReticleTool } from '@reticlehq/core';
import { LastAct } from '@/portal/session/last-act.js';
import type { CommandResult } from '@reticlehq/core';
import type { Session } from '@/portal/session/session.js';
import type { SessionManager } from '@/portal/session/session-manager.js';
import type { ToolDeps } from './tools.js';
import { RecordingStore } from '@/language/flows/recording/tape/recordings.js';

const PAGE = 'http://localhost:3000/login';

/** A same-URL navigation whose replacement document connects while the dispatch reply is pending. */
function samePageDeps(): ToolDeps {
  let documentId = 'doc-old';
  const session = {
    id: 's-old',
    url: PAGE,
    elapsed: () => 0,
    lastAct: new LastAct(),
    beginAction: () => 'a1',
    finishAction: () => undefined,
    get currentDocumentId(): string {
      return documentId;
    },
    command: (): Promise<CommandResult> => {
      documentId = 'doc-new'; // the replacement reports before NAVIGATE answers
      return Promise.resolve({
        kind: 'command_result',
        id: 'c',
        ok: true,
        result: { ok: true, url: PAGE },
      });
    },
  } as unknown as Session;
  const sessions: Partial<SessionManager> = {
    resolve: () => session,
    // One tab is connected, so navigate drives it rather than starting a session of its own.
    count: () => 1,
    get: () => session,
    all: () => [session],
  };
  return {
    sessions: sessions as SessionManager,
    now: () => 0,
    recordings: new RecordingStore(),
  } as unknown as ToolDeps;
}

const nav = BROWSER_TOOLS.find((t) => t.name === ReticleTool.NAVIGATE);

describe('a same-URL navigation whose replacement connects during dispatch', () => {
  it('confirms the driven session instead of timing out', async () => {
    const out = await nav?.handler(samePageDeps(), { url: PAGE, timeout_ms: 1_000 });
    expect(out).toMatchObject({ ok: true, confirmed: true, sessionId: 's-old' });
  });
});
