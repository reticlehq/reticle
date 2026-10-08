/**
 * The connect proof for a run with no system browser to lean on: `init --no-open`, CI, a container,
 * an agent, or a launcher that failed.
 *
 * Opens the app in a lease on the daemon at `port`, over the MCP transport every daemon serves --
 * the same route `reticle verify` takes, so there is no second browser stack and no second daemon
 * fighting this one for the port.
 */

import {
  acquireLease,
  connectOverSse,
  endpointFor,
  releaseLease,
  type ToolCaller,
} from '@/command/cli/adhoc-verdict.js';

/** A lease this run opened, and the way to hand it back; or why it could not be opened. */
type LeaseOutcome =
  | {
      readonly sessionId: string;
      readonly zeroInstall: boolean;
      readonly release: () => Promise<void>;
    }
  | { readonly failed: string };

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function openLeaseFor(
  port: number,
  url: string,
  token: string | undefined,
): Promise<LeaseOutcome> {
  let caller: ToolCaller;
  try {
    caller = await connectOverSse(endpointFor(port, token));
  } catch (error) {
    return { failed: `could not reach the daemon on port ${String(port)}: ${reason(error)}` };
  }
  const close = (): Promise<void> => caller.close().catch(() => undefined);
  try {
    const got = await acquireLease(caller, url);
    if ('failed' in got) {
      await close();
      return { failed: got.failed.join(' ') };
    }
    return {
      sessionId: got.leased,
      zeroInstall: got.zeroInstall,
      release: async () => {
        await releaseLease(caller, got.leased);
        await close();
      },
    };
  } catch (error) {
    await close();
    return { failed: reason(error) };
  }
}
