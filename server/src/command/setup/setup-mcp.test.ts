/**
 * `reticle setup mcp` — does the installer actually register the agents on this machine?
 *
 * The case that made this file exist: Claude Code is Reticle's most common client and
 * `setup mcp` never registered it. `detectMcpClients` reads CONFIG FILES, and Claude Code keeps
 * none — it owns its registration behind `claude mcp add`. So its spec is `ConfigScope.CLI`,
 * `fileBackedClients()` filters CLI scope out by construction, and the `ConfigScope.CLI` branch
 * inside the loop over those clients could never run. A one-line install on a machine with Claude
 * Code printed "No coding agent config found", reported `agents_detected` completed with zero and
 * `mcp_registered` skipped, and left the person with an installed CLI and an agent with no tools.
 *
 * There was no test here, which is the other half of the story.
 */

import { describe, expect, it } from 'vitest';
import { setupMcp, type SetupMcpIo } from './setup-mcp.js';
import type { OnboardingStep } from '@reticlehq/core/telemetry';

const CLAUDE = 'claude';

interface Machine {
  /** Is the `claude` CLI installed here? */
  claudeInstalled?: boolean;
  /** Does it already hold a `reticle` server entry? */
  claudeAlreadyRegistered?: boolean;
  /** Config files this machine keeps, by path suffix. */
  files?: Record<string, string>;
}

interface Recorded {
  io: SetupMcpIo;
  writes: { path: string; contents: string }[];
  ran: string[];
  steps: OnboardingStep[];
  lines: string[];
}

function machine(m: Machine = {}): Recorded {
  const files = m.files ?? {};
  const writes: { path: string; contents: string }[] = [];
  const ran: string[] = [];
  const steps: OnboardingStep[] = [];
  const lines: string[] = [];
  // Home-relative, and separator-normalised: `join` emits backslashes on Windows and the marker for
  // most clients is the DIRECTORY above the config, so a plain suffix match would miss it.
  const rel = (p: string): string => p.replace(/\\/g, '/').replace(/^\/home\/u\//, '');
  const io: SetupMcpIo = {
    exists: (p) => Object.keys(files).some((f) => f === rel(p) || f.startsWith(`${rel(p)}/`)),
    readFile: (p) => files[rel(p)] ?? null,
    writeFile: (path, contents) => void writes.push({ path, contents }),
    homeDir: () => '/home/u',
    print: (l) => void lines.push(l),
    runCli: (command, args) => {
      ran.push(`${command} ${args.join(' ')}`);
      if (CLAUDE !== command) return false;
      if (true !== m.claudeInstalled) return false;
      // `claude mcp get reticle` exits 0 only when an entry is already there.
      if (args.includes('get')) return true === m.claudeAlreadyRegistered;
      return true;
    },
    reportStep: (s) => void steps.push(s),
  };
  return { io, writes, ran, steps, lines };
}

const stepStatus = (steps: OnboardingStep[], name: string): string | undefined =>
  steps.find((s) => s.step === name)?.status;

describe('a client that owns its own registration is still a client', () => {
  it('detects and registers Claude Code, which keeps no config file to find', () => {
    const { io, ran } = machine({ claudeInstalled: true });
    const result = setupMcp(io);

    expect(result.detected, 'Claude Code was on the machine and went unseen').toContain(
      'claude-code',
    );
    expect(result.registered).toContain('claude-code');
    expect(
      ran.some((c) => c.includes('mcp add')),
      `commands run: ${ran.join(' | ')}`,
    ).toBe(true);
  });

  it('reports it as already there rather than registering twice', () => {
    const { io, ran } = machine({ claudeInstalled: true, claudeAlreadyRegistered: true });
    const result = setupMcp(io);

    expect(result.detected).toContain('claude-code');
    expect(result.alreadyThere).toContain('claude-code');
    expect(result.registered).not.toContain('claude-code');
    expect(ran.some((c) => c.includes('mcp add'))).toBe(false);
  });

  // The negative control. Without this, "detect everything always" would pass the two above and
  // would claim an agent nobody has.
  it('does not claim Claude Code on a machine that does not have it', () => {
    const { io } = machine({ claudeInstalled: false });
    const result = setupMcp(io);

    expect(result.detected).not.toContain('claude-code');
    expect(result.registered).toEqual([]);
  });
});

describe('the funnel reports what actually happened', () => {
  it('counts a machine with Claude Code as registered, not skipped', () => {
    const { io, steps } = machine({ claudeInstalled: true });
    setupMcp(io);

    expect(stepStatus(steps, 'agents_detected')).toBe('completed');
    expect(stepStatus(steps, 'mcp_registered')).toBe('completed');
  });

  it('still skips honestly on a machine with no agent at all', () => {
    const { io, steps } = machine({ claudeInstalled: false });
    setupMcp(io);

    expect(stepStatus(steps, 'agents_detected')).toBe('completed');
    expect(stepStatus(steps, 'mcp_registered')).toBe('skipped');
  });
});

describe('file-backed clients still work', () => {
  it('writes into a config a client already keeps', () => {
    const { io, writes } = machine({ files: { '.cursor/mcp.json': '{}\n' } });
    const result = setupMcp(io);

    expect(result.detected).toContain('cursor');
    expect(writes.length).toBeGreaterThan(0);
    expect(writes[0]?.contents).toContain('reticle');
  });

  it('never creates a config for a client this machine does not use', () => {
    const { io, writes } = machine({});
    setupMcp(io);

    expect(writes).toEqual([]);
  });
});
