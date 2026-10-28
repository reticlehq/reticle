/**
 * The one-line installer and `reticle init` did not say whether the agent connected. `setup mcp`
 * waited for it, but the installer sends `setup install` output to a file, so stdout was not a
 * terminal and the wait never ran; `init` printed only its own restart notice.
 *
 * `reticle setup wait-agents` is the installer's last step, run with the terminal attached. `init`
 * prints the same "Your agents:" block and runs the same bounded wait. The clock is injected.
 */
import { describe, expect, it } from 'vitest';
import { AgentClient } from '@reticlehq/core/telemetry';
import { McpClient } from '@reticlehq/init';
import { RETICLE_DEFAULT_PORT } from '@reticlehq/core';
import { AgentReg, type AgentRow } from '@/command/setup/agent-next-steps.js';
import { parseCliArgs } from './cli-parse.js';
import { agentsBlock, reportConnections, type ConnectionWait } from './setup-mcp-cli.js';

const ROWS: AgentRow[] = [
  { id: McpClient.CLAUDE_CODE, reg: AgentReg.ADDED },
  { id: McpClient.CURSOR, reg: AgentReg.MISSING },
];

function fakeWait(connectAt: number | undefined): ConnectionWait & { now: () => number } {
  let t = 0;
  const seen = new Set<string>();
  return {
    now: () => t,
    read: () => {
      if (connectAt !== undefined && t >= connectAt) {
        seen.add(AgentClient.CLAUDE_CODE);
      }
      return seen;
    },
    clock: {
      now: () => t,
      sleep: (ms) => {
        t += ms;
        return Promise.resolve();
      },
    },
  };
}

describe('the bounded wait, on an injected clock', () => {
  it('says which agent connected and the step the other still needs', async () => {
    const out: string[] = [];
    const wait = fakeWait(4000);
    await reportConnections(ROWS, (l) => out.push(l), wait);
    expect(out.some((l) => l.startsWith('Waiting up to 60s'))).toBe(true);
    expect(out).toContain('Connected: Claude Code ✓');
    expect(out).toContain('Cursor not added: run `reticle setup mcp`');
    expect(wait.now()).toBe(4000);
  });

  it('gives up at the budget', async () => {
    const out: string[] = [];
    const wait = fakeWait(undefined);
    await reportConnections(ROWS, (l) => out.push(l), wait);
    expect(wait.now()).toBe(60_000);
    expect(
      out.some((l) => l.startsWith('Claude Code not connected yet: restart Claude Code')),
    ).toBe(true);
  });

  it('does not wait when no agent has Reticle registered', async () => {
    const out: string[] = [];
    const wait = fakeWait(0);
    await reportConnections(
      [{ id: McpClient.CURSOR, reg: AgentReg.MISSING }],
      (l) => out.push(l),
      wait,
    );
    expect(out).toEqual([]);
    expect(wait.now()).toBe(0);
  });
});

describe('init prints the "Your agents:" block, and waits only where a person watches', () => {
  it('prints the block now, and the wait when it is run', async () => {
    const out: string[] = [];
    const wait = fakeWait(1000);
    const later = agentsBlock(ROWS, (l) => out.push(l), true, wait);
    expect(out[0]).toBe('Your agents:');
    expect(out.join('\n')).not.toContain('Connected:');
    await later();
    expect(out).toContain('Connected: Claude Code ✓');
  });

  it('prints the block and does not wait without a terminal', async () => {
    const out: string[] = [];
    const wait = fakeWait(1000);
    await agentsBlock(ROWS, (l) => out.push(l), false, wait)();
    expect(out[0]).toBe('Your agents:');
    expect(out.join('\n')).not.toContain('Waiting');
    expect(wait.now()).toBe(0);
  });
});

describe('`reticle setup wait-agents`', () => {
  it('parses as its own command, not as help', () => {
    expect(parseCliArgs(['setup', 'wait-agents'], RETICLE_DEFAULT_PORT).kind).toBe(
      'setup-wait-agents',
    );
  });
});
