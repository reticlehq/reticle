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
  // A registered Claude Code is an entry in its state file — which is what is read now, instead of
  // `claude mcp get`, which launches the server to health-check it.
  const files: Record<string, string> = {
    ...(true === m.claudeAlreadyRegistered
      ? { '.claude.json': JSON.stringify({ mcpServers: { reticle: { command: 'npx' } } }) }
      : {}),
    ...(m.files ?? {}),
  };
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
    expect(
      ran.some((c) => /\bmcp (get|list)\b/.test(c)),
      'launched the server to check',
    ).toBe(false);
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

/**
 * A format we decline to rewrite must not be reported as registered.
 *
 * Codex CLI keeps TOML, and `mergeClientConfig` answers MANUAL for it: the result's `content` is
 * documented as byte-identical to the existing file in that case. The loop handled ALREADY and
 * treated everything else as applied, so Codex was pushed onto `registered` and its config written
 * back unchanged. Two ways that hurt, and both were reproduced against a sandboxed HOME before this
 * test existed: with a config present the file gained nothing while the installer said
 * `registered  codex`, and with none present it created a ZERO-BYTE `config.toml` and said the same.
 * Either way a Codex user was told they were set up, had no Reticle tools, and was shown no snippet.
 */
describe('a config format we will not rewrite', () => {
  const CODEX_CONFIG = '.codex/config.toml';
  const EXISTING = '[mcp_servers.other]\ncommand = "foo"\n';

  it('is reported as needing a hand, not as registered', () => {
    const { io } = machine({ files: { [CODEX_CONFIG]: EXISTING } });
    const result = setupMcp(io);

    expect(result.detected, 'the marker was there, so it was seen').toContain('codex');
    expect(
      result.registered,
      'claiming this leaves a Codex user with no tools and no instruction',
    ).not.toContain('codex');
    expect(result.manual.map((c) => c.id)).toContain('codex');
  });

  it('names the file to edit and where the shape is documented', () => {
    const { io } = machine({ files: { [CODEX_CONFIG]: EXISTING } });
    const entry = setupMcp(io).manual.find((c) => 'codex' === c.id);

    // Compared with forward slashes because `configPath` is built by `join()`, which emits `\` on
    // Windows: the raw value there is `...\.codex\config.toml` and a POSIX-spelled `toContain`
    // can never match it. The product is right -- that IS the actionable path on that machine --
    // so it is the assertion that has to stop being platform-specific. This went red on the
    // `windows` CI job, which had been green on the three runs before it.
    expect(
      entry?.configPath.replaceAll('\\', '/'),
      'a manual step with no path is not actionable',
    ).toContain(CODEX_CONFIG);
    expect(entry?.docs, 'the TOML shape is the part nobody can guess').toBeDefined();
  });

  it('does not touch the file, so an existing config is never rewritten', () => {
    const { io, writes } = machine({ files: { [CODEX_CONFIG]: EXISTING } });
    setupMcp(io);

    expect(
      writes.filter((w) => w.path.includes('.codex')),
      'writing byte-identical content is at best a no-op and at worst a truncation',
    ).toEqual([]);
  });

  it('creates no file at all when there is none, rather than an empty one', () => {
    // The marker is the DIRECTORY, so the client is detected with no config file present.
    const { io, writes } = machine({ files: { '.codex/other.toml': 'x' } });
    setupMcp(io);

    expect(
      writes.filter((w) => w.path.includes('config.toml')),
      'an empty config.toml reads as a finished registration to everything that looks at it',
    ).toEqual([]);
  });

  /* The rest of the machine must still register, or one manual client would cost every other one. */
  it('does not stop the clients it CAN write', () => {
    const { io } = machine({
      claudeInstalled: true,
      files: { [CODEX_CONFIG]: EXISTING, '.cursor/mcp.json': '{}' },
    });
    const result = setupMcp(io);

    expect(result.registered).toContain('claude-code');
    expect(result.registered).toContain('cursor');
    expect(result.manual.map((c) => c.id)).toContain('codex');
  });
});

/**
 * The funnel must not count a machine with the tools NOWHERE as an install.
 *
 * `mcp_registered` fell through to COMPLETED whenever anything was detected, so a machine whose only
 * client was one we decline to write for (Codex, TOML) was reported as registered. That is the one
 * number that answers "did this machine get Reticle", and it read yes for exactly the people it read
 * no for. Registering SOME clients is still a completed step; registering none of them is not.
 */
describe('what the funnel is told about registration', () => {
  const statusOf = (steps: OnboardingStep[]): string | undefined =>
    stepStatus(steps, 'mcp_registered');

  it('reports FAILED when every client found needs a hand', () => {
    const { io, steps } = machine({ files: { '.codex/config.toml': '[mcp_servers.other]\n' } });
    setupMcp(io);
    expect(
      statusOf(steps),
      'the tools are registered nowhere, so this is not a completed step',
    ).toBe('failed');
  });

  it('still reports COMPLETED when at least one client was written', () => {
    const { io, steps } = machine({
      claudeInstalled: true,
      files: { '.codex/config.toml': '[mcp_servers.other]\n' },
    });
    setupMcp(io);
    expect(statusOf(steps), 'a partial win is not a failed step').toBe('completed');
  });

  it('still reports SKIPPED when there was no agent at all', () => {
    const { io, steps } = machine();
    setupMcp(io);
    expect(statusOf(steps), 'no agent here is not our failure').toBe('skipped');
  });
});
