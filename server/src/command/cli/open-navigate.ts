import { ReticleTool } from '@reticlehq/core';
import { connectOverSse, endpointFor, type ToolCaller } from './adhoc-verdict.js';
import {
  readOrCreatePairingTokenSync,
  defaultPairingTokenDir,
} from '@/portal/bridge/pairing-token.js';

/**
 * `reticle open <url> --navigate`: move the tab that is already on this origin to `url`.
 *
 * The default leaves that tab where it is, on purpose: `open` is often run by a person whose tab it
 * is (see `decideOpen`). But a caller with no MCP tools, a shell loop or an agent whose MCP link
 * timed out, then had no way past the first page of a multi-page site short of restarting the
 * daemon (#1140). This is the explicit opt-in. It sends the same `reticle_navigate` an agent would,
 * over the daemon's own SSE transport, exactly as `verify --expect` does, and waits for arrival.
 */
export interface OpenNavigateOptions {
  port: number;
  sessionId: string;
  url: string;
  /**
   * The daemon's pairing token. Omitted, it is read here, the way `verify --expect` reads it, so the
   * CLI entry point does not reach into the bridge itself. A test that injects `connect` gets none.
   */
  token?: string;
  /** Injected so a test does not need a live daemon. */
  connect?: (endpoint: URL) => Promise<ToolCaller>;
}

/** Named, as the repository asks of every user-facing string. */
const DAEMON_UNREACHABLE = 'could not reach the daemon to navigate';
const NAVIGATE_FAILED = 'navigate failed';
const NO_ARRIVAL_REPORTED = 'reticle_navigate did not report arrival';
/** Accepted by the browser, but no page on the url was observed: not `navigated`, and not an error. */
export const NAVIGATE_UNCONFIRMED_NOTE =
  'the browser accepted the navigation, but no page on that url reconnected in the wait window, so ' +
  'arrival was not observed. Re-run `reticle status` before relying on the tab being there.';

/** The fields `reticle_navigate` answers with that a CLI reader acts on. */
function navigateReport(result: unknown): Record<string, unknown> | undefined {
  if (typeof result !== 'object' || null === result) return undefined;
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if ('object' === typeof structured && null !== structured) {
    return structured as Record<string, unknown>;
  }
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    const text = (part as { text?: unknown }).text;
    if ('string' !== typeof text) continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if ('object' === typeof parsed && null !== parsed) return parsed as Record<string, unknown>;
    } catch {
      // not the report
    }
  }
  return undefined;
}

/**
 * Navigate the session and describe the outcome as fields for the `reticle_open` line. `navigated`
 * is set only when the tool says the page arrived; otherwise the tool's own reason is passed on,
 * never a success the navigate did not report.
 */
export async function navigateLeftTab(
  options: OpenNavigateOptions,
): Promise<Record<string, unknown>> {
  const connect = options.connect ?? connectOverSse;
  let caller: ToolCaller;
  try {
    const token =
      options.token ??
      (options.connect === undefined
        ? readOrCreatePairingTokenSync(defaultPairingTokenDir())
        : undefined);
    caller = await connect(endpointFor(options.port, token));
  } catch (error) {
    return {
      error: `${DAEMON_UNREACHABLE}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    const result = await caller.call(ReticleTool.NAVIGATE, {
      url: options.url,
      sessionId: options.sessionId,
    });
    const report = navigateReport(result) ?? {};
    const landedOn = 'string' === typeof report['landedOn'] ? report['landedOn'] : undefined;
    // A navigation reconnects as a NEW session; the id to act on next is the arrival's, not ours.
    const arrivedAs =
      'string' === typeof report['sessionId'] ? report['sessionId'] : options.sessionId;
    if (true === report['ok'] && false === report['confirmed'] && landedOn === undefined) {
      return { requested: options.url, sessionId: arrivedAs, note: NAVIGATE_UNCONFIRMED_NOTE };
    }
    if (true === report['ok']) {
      return {
        navigated: options.url,
        sessionId: arrivedAs,
        ...(landedOn === undefined ? {} : { landedOn }),
      };
    }
    const reason =
      'string' === typeof report['reason']
        ? report['reason']
        : 'string' === typeof report['error']
          ? report['error']
          : NO_ARRIVAL_REPORTED;
    return {
      error: `${NAVIGATE_FAILED} (${options.url}): ${reason}`,
      sessionId: options.sessionId,
    };
  } catch (error) {
    return {
      error: `${NAVIGATE_FAILED} (${options.url}): ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await caller.close().catch(() => undefined);
  }
}
