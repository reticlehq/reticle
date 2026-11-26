/**
 * `reticle_attach_tab`: join a tab that is open in the person's own browser, as a session.
 *
 * The browser realm reads a page from the inside (its network, its state, a click the page takes)
 * only when its reader is in the page. `reticle drive` puts it in a tab of its own, in an isolated
 * context signed in to nothing. This puts it in a tab the person already has open, over the
 * browser's debugging port: their mail, a cloud console, a tool they are signed in to.
 */
import { bridgeWsUrl, ReticleEnv, ReticleTool } from '@reticlehq/core';
import { z } from 'zod';

import {
  attachTab,
  detachTabs,
  type AttachedTab,
  type AttachTabOptions,
} from '@/portal/pool/attach-tab.js';
import { readReaderBundle, zeroInstallScript } from '@/portal/pool/zero-install.js';
import type { ToolDef, ToolDeps } from './tool-kit.js';

const DEFAULT_CDP_URL = 'http://127.0.0.1:9222';
/** How long the tab's reader may take to connect after the reload. */
const DEFAULT_WAIT_MS = 15_000;
const POLL_MS = 250;

/** What the attach uses. Tests give their own. */
export interface AttachIo {
  attach?: (opts: AttachTabOptions) => Promise<AttachedTab>;
  bundle?: string;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export async function runAttachTab(
  deps: ToolDeps,
  args: Record<string, unknown>,
  io: AttachIo = {},
): Promise<Record<string, unknown>> {
  const match = 'string' === typeof args['match'] ? args['match'] : '';
  const cdpUrl =
    ('string' === typeof args['cdpUrl'] ? args['cdpUrl'] : undefined) ??
    process.env[ReticleEnv.CDP_URL] ??
    DEFAULT_CDP_URL;
  const waitMs = 'number' === typeof args['waitMs'] ? args['waitMs'] : DEFAULT_WAIT_MS;
  if (true === args['detach']) {
    // The end of a task: every joined tab has its page security again, and the connection closes.
    return { ok: true, detached: await detachTabs(cdpUrl) };
  }
  if ('' === match) {
    return { ok: false, error: 'give `match`: part of the address of the one tab to join.' };
  }
  const nonces = deps.nonces;
  const port = deps.bridgePort;
  if (nonces === undefined || port === undefined) {
    return {
      ok: false,
      error:
        'this daemon makes no pass for a page of another origin, so a tab cannot join it. Run the tool through the Reticle daemon (`reticle serve` or `reticle mcp`).',
    };
  }
  const bundle = io.bundle ?? readReaderBundle();
  // The pass is for the origin of the tab only: the bridge admits a page of that origin and no other.
  const scriptFor = (url: string): string | undefined =>
    bundle === undefined
      ? undefined
      : zeroInstallScript(bundle, {
          url: bridgeWsUrl(port),
          token: nonces.mint({ origin: new URL(url).origin }).nonce,
        });
  const before = new Set(deps.sessions.all().map((s) => s.id));
  let attached: AttachedTab;
  try {
    attached = await (io.attach ?? attachTab)({ cdpUrl, match, scriptFor });
  } catch (error) {
    return {
      ok: false,
      error: `${String((error as Error).message ?? error)} The browser must run with --remote-debugging-port, at ${cdpUrl}.`,
    };
  }
  const origin = new URL(attached.url).origin;
  for (let waited = 0; waited <= waitMs; waited += POLL_MS) {
    const joined = deps.sessions
      .all()
      .find((s) => !before.has(s.id) && URL.canParse(s.url) && new URL(s.url).origin === origin);
    if (joined !== undefined) {
      return { ok: true, sessionId: joined.id, url: attached.url, title: attached.title };
    }
    await sleep(POLL_MS);
  }
  if ('prompt' === attached.localNetwork) {
    return {
      ok: false,
      error: `the tab "${attached.title}" has the reader, and the browser holds its connection to the daemon until a person allows local network access. The grant did not reach this tab: it is in a browser profile that is not in front. Bring that profile to the front and attach again, or press "Allow" on the browser's prompt.`,
    };
  }
  return {
    ok: false,
    error: `the tab "${attached.title}" was reloaded with the reader, and no session of ${origin} joined in ${String(waitMs)} ms. The page may block scripts that the debugging port adds.`,
  };
}

export const ATTACH_TAB_TOOL: ToolDef = {
  name: ReticleTool.ATTACH_TAB,
  description:
    "Join a tab that is open in the person's own browser, as a session: their mail, a cloud console, a tool they are signed in to. The browser must run with --remote-debugging-port (default http://127.0.0.1:9222, or RETICLE_CDP_URL). `match` is part of the address of the one tab. The tab is reloaded once, and its page security is set aside for this connection only. A password vault or a sign-in page is never joined. Answers with the sessionId to give every later call. Give { detach: true } at the end of the task.",
  inputSchema: {
    // Optional so that `{ detach: true }` alone passes: a required `match` refused the detach.
    match: z.string().min(1).optional().describe('Part of the address of the one tab to join.'),
    cdpUrl: z.string().optional().describe('The debugging address of the browser.'),
    waitMs: z.number().int().positive().max(60_000).optional(),
    detach: z
      .boolean()
      .optional()
      .describe(
        'true at the end of the task: every joined tab gets its page security back, and the connection closes.',
      ),
  },
  handler: (deps, args) => runAttachTab(deps, args),
};
