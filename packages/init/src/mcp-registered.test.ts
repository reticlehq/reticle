/**
 * `mcpRegistered: true` when the MCP server was never registered.
 *
 * The flag was `!failed.has(MCP_TARGET)` — the negation of one narrow failure set. A step that was
 * SKIPPED (`--no-mcp`) or left MANUAL (registration could not be automated, the user has to run a
 * command) is in neither set, so both reported success. Under `--no-mcp` — which the install gate
 * uses — every run claimed the MCP server was registered.
 *
 * That is the onboarding funnel's most important field lying in the flattering direction, on the
 * exact runs least likely to have a working install.
 *
 * Registered means REGISTERED: the step applied, or it was already in place. Nothing else counts.
 */

import { describe, expect, it } from 'vitest';
import { StepStatus } from './plan.js';
import { wasMcpRegistered } from './mcp-registered.js';

describe('wasMcpRegistered', () => {
  it('is true when the step applied, or was already there', () => {
    expect(wasMcpRegistered(StepStatus.APPLY)).toBe(true);
    expect(wasMcpRegistered(StepStatus.ALREADY)).toBe(true);
  });

  it('is FALSE when it was skipped — --no-mcp registers nothing', () => {
    expect(wasMcpRegistered(StepStatus.SKIP)).toBe(false);
  });

  it('is FALSE when it needs the human to run something', () => {
    // A MANUAL step is a guaranteed non-registration until somebody acts on it.
    expect(wasMcpRegistered(StepStatus.MANUAL)).toBe(false);
  });

  it('is FALSE when there was no MCP step at all', () => {
    expect(wasMcpRegistered(undefined)).toBe(false);
  });
});
