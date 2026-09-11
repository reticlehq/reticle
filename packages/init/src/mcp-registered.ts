/**
 * Did `reticle init` actually register the MCP server?
 *
 * This was `!failed.has(MCP_TARGET)` — the negation of one narrow failure set — so a step that was
 * SKIPPED (`--no-mcp`) or left MANUAL (the user has to run a command themselves) reported success,
 * because neither is a failure. Under `--no-mcp` every run claimed registration.
 *
 * It is the onboarding funnel's most important field, and it was wrong in the flattering direction
 * on exactly the runs least likely to have a working install.
 */
import { StepStatus } from './plan.js';

export function wasMcpRegistered(status: StepStatus | undefined): boolean {
  return status === StepStatus.APPLY || status === StepStatus.ALREADY;
}
