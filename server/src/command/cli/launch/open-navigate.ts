import { ReticleTool } from '@reticlehq/core';
import { connectOverSse, endpointFor, type ToolCaller } from '@/command/cli/adhoc-verdict.js';

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
  token?: string;
  /** Injected so a test does not need a live daemon. */
  connect?: (endpoint: URL) => Promise<ToolCaller>;
}

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
    caller = await connect(endpointFor(options.port, options.token));
  } catch (error) {
    return {
      error: `could not reach the daemon to navigate: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    const result = await caller.call(ReticleTool.NAVIGATE, {
      url: options.url,
      sessionId: options.sessionId,
    });
    const report = navigateReport(result) ?? {};
    const landedOn = 'string' === typeof report['landedOn'] ? report['landedOn'] : undefined;
    if (true === report['ok']) {
      return {
        navigated: options.url,
        sessionId: options.sessionId,
        ...(landedOn === undefined ? {} : { landedOn }),
        ...(false === report['confirmed'] ? { confirmed: false } : {}),
      };
    }
    const reason =
      'string' === typeof report['reason']
        ? report['reason']
        : 'string' === typeof report['error']
          ? report['error']
          : 'reticle_navigate did not report arrival';
    return { error: `navigate to ${options.url} failed: ${reason}`, sessionId: options.sessionId };
  } catch (error) {
    return {
      error: `navigate to ${options.url} failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await caller.close().catch(() => undefined);
  }
}
