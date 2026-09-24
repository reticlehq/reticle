/**
 * The saved-flow suite, against the daemon that is already running.
 *
 * `runAdhocVerdict` next door removed one half of a dead end: an agent whose client never loaded
 * the `reticle_*` tools could not reach a verdict, because `verify` refuses when the daemon owns
 * the port and a working install is exactly the state where the daemon owns the port.
 *
 * This is the other half. `--expect` serves a project with NO saved flows; a project WITH them was
 * still stuck, and worse off, because the whole promise of a saved suite is that it runs again
 * without an agent. The documented way out was to stop the daemon, which kills the agent's MCP
 * link, and our own guidance says never to do it.
 *
 * Same trick, and deliberately no new surface: ask the running daemon the question an agent would
 * ask it, over the transport `start()` already attaches unconditionally. Nothing is bound, nothing
 * is stopped, the agent keeps its link.
 */
import { ReticleTool } from '@reticlehq/core';
import {
  connectOverSse,
  endpointFor,
  refusalText,
  verdictOf,
  type AdhocVerdict,
  type ToolCaller,
} from './adhoc-verdict.js';

export interface AdhocSuiteOptions {
  port: number;
  /** Run only flows carrying ANY of these labels. Omitted runs the whole suite. */
  select?: string[];
  /** Which connected tab to drive. Omitted means "whatever is connected". */
  sessionId?: string;
  token?: string;
  /** Injected so a test does not need a live daemon. */
  connect?: (endpoint: URL) => Promise<ToolCaller>;
}

/** The only status that is a pass. `unverifiable` means nothing was checked, which is not one. */
const PASSED = 'pass';

/**
 * Run the saved suite through the daemon on this port.
 *
 * Exit code 0 ONLY for `status: "pass"`. `unverifiable` exits non-zero on purpose: it is what an
 * empty suite reports, and a CI step that reads "nothing was checked" as success is the false green
 * this product exists to prevent.
 */
export async function runAdhocSuite(options: AdhocSuiteOptions): Promise<AdhocVerdict> {
  const connect = options.connect ?? connectOverSse;
  let caller: ToolCaller;
  try {
    caller = await connect(endpointFor(options.port, options.token));
  } catch (error) {
    return {
      code: 1,
      lines: [
        `could not reach the daemon on port ${String(options.port)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'It answers `reticle status`; if that works and this does not, the daemon is older than this CLI.',
      ],
    };
  }
  try {
    // Spread rather than set: an explicit `undefined` is a key the tools reject as an unknown
    // parameter, which would turn "no tab named" into a refusal. Same rule as the one-shot path.
    const result = await caller.call(ReticleTool.VERIFY, {
      action: 'flows',
      ...(options.select === undefined ? {} : { select: options.select }),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    });
    const refusal = refusalText(result);
    if (refusal !== undefined) return { code: 1, lines: ['status: unverifiable', refusal] };
    const report = verdictOf(result);
    const status = 'string' === typeof report?.['status'] ? report['status'] : 'unverifiable';
    const summary = 'string' === typeof report?.['summary'] ? report['summary'] : undefined;
    return {
      code: PASSED === status ? 0 : 1,
      lines: [
        `status: ${status}`,
        ...(summary === undefined ? [] : [summary]),
        JSON.stringify(report ?? result, null, 2),
      ],
    };
  } catch (error) {
    return {
      code: 1,
      lines: [
        `the suite could not be run: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  } finally {
    await caller.close().catch(() => undefined);
  }
}
