/** Which proxied calls are Harness drives, and what to tell an agent whose drive call was lost. */
import { ReticleTool } from '@reticlehq/core';

const TOOLS_CALL = 'tools/call';
const EXPLORE_ACTION = 'explore';

/** A `tools/call` of reticle_verify explore, directly or through the reticle_run hatch. */
export function isHarnessDriveCall(msg: { method?: unknown; params?: unknown }): boolean {
  if (TOOLS_CALL !== msg.method) return false;
  const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  if (ReticleTool.VERIFY_EXPLORE === params.name) return true;
  if (ReticleTool.VERIFY === params.name) return EXPLORE_ACTION === args['action'];
  if (ReticleTool.RUN !== params.name) return false;
  const inner = (args['args'] ?? {}) as Record<string, unknown>;
  return (
    ReticleTool.VERIFY_EXPLORE === args['tool'] ||
    (ReticleTool.VERIFY === args['tool'] && EXPLORE_ACTION === inner['action'])
  );
}

/**
 * A drive lives in the daemon, not in the call: a lost connection does not end it, and retrying the
 * call as if it had not run pays for a second drive.
 */
export const MSG_DRIVE_MAY_BE_RUNNING =
  `The Harness drive this call started or polled may still be running in the daemon. Once ` +
  `Reticle reconnects, call ${ReticleTool.VERIFY} {action:"explore"} with no runId to get the ` +
  `running drive back (it will not start a second), then poll it by runId.`;
