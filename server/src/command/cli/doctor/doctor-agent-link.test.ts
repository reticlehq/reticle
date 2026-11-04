/**
 * The agent link row must say what is true NOW, not what a record says once was true.
 *
 * The defect this covers is reticlehq/reticle#1710: when the port was held but `/status` did
 * not answer, the row still printed the stored attach record as healthy, or told the user to
 * restart the client — the one fix that does not help. In that state the row now points at the
 * daemon row above, which already names the one fix, and it prints no command of its own.
 * Only a split brain outranks it, because a split is the one case where the record is not
 * even about this daemon.
 */

import { describe, expect, it } from 'vitest';
import { agentLinkText } from './doctor-agent-link.js';

const RECORD_HEALTHY =
  '✓ an MCP client attached here and called tools before (a record, not a live check)';
const RESTART_CLIENT =
  'an MCP client started Reticle on this port and never asked for the tool list, so the tools are here and your client has not read them — restart your MCP client';
const POINTER = 'follow the daemon row above';

describe('agentLinkText', () => {
  it('keeps the healthy record when the port is not foreign', () => {
    expect(agentLinkText({ split: undefined, attachAction: undefined, foreign: false })).toBe(
      RECORD_HEALTHY,
    );
  });

  it('a foreign port replaces the healthy record with a pointer to the daemon row', () => {
    const text = agentLinkText({ split: undefined, attachAction: undefined, foreign: true });
    expect(text).toContain(POINTER);
    expect(text).not.toContain(RECORD_HEALTHY);
    expect(text).not.toContain('reticle stop');
    expect(text).not.toContain('reticle serve --restart --force');
  });

  it('a foreign port replaces the restart-client advice too', () => {
    const text = agentLinkText({
      split: undefined,
      attachAction: RESTART_CLIENT,
      foreign: true,
    });
    expect(text).toContain(POINTER);
    expect(text).not.toContain('restart your MCP client');
  });

  it('a split still outranks the foreign port', () => {
    expect(
      agentLinkText({
        split: 'another daemon serves this project',
        attachAction: undefined,
        foreign: true,
      }),
    ).toBe('✗ another daemon serves this project');
  });

  it('keeps the attach action when the port is not foreign', () => {
    expect(agentLinkText({ split: undefined, attachAction: RESTART_CLIENT, foreign: false })).toBe(
      `✗ ${RESTART_CLIENT}`,
    );
  });
});
