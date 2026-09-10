/**
 * Profiling the event vocabulary against one real day of production data
 * (`plan/export-2026-08-07-205221.csv`, 1,468 events) turned up three things that are not opinions.
 *
 * 1. `cli_command_run` IS MOSTLY NOT A HUMAN COMMAND. 475 of 561 (85%) are `command: 'mcp'` — the
 *    agent's MCP client spawning its transport, which no person typed. The event's stated purpose is
 *    "human intent: `verify`/`gate` vs `status`", and 85% of it is neither. Its own docstring already
 *    excludes the spawned `_daemon` child for exactly this reason; `mcp` is the same act one level up.
 *    `mcp_client_connected` already reports an agent attaching, with strictly more detail.
 *
 * 2. IT IS ALSO WHY THE SESSION COUNT IS WRONG. `sessionId` is minted per PROCESS, so every one-shot
 *    CLI command invents one. Measured: uniq(sessionId) = 704 across the day, of which 561 came from
 *    `cli_command_run` and **not one of them is shared with any daemon**. The real number of daemon
 *    runs is 121. Every tile that counts sessions is therefore ~6x high, and no join on those ids can
 *    ever succeed — so omitting them loses nothing that works today.
 *
 * 3. `actor` ON `cli_command_run` IS CONSTANT. All 561 say `human`, which is both zero information
 *    and wrong for the 475 that were the agent's transport. Once `mcp` is excluded the event is human
 *    by definition and the property is pure payload.
 *
 * `actor` stays where it EARNS its place — on `verification_completed` and `bug_found`, where it
 * splits the agent's own loop from a human/CI-triggered run.
 */

import { describe, expect, it } from 'vitest';
import { TelemetryEventKind, isSessionScoped } from '@reticlehq/core/telemetry';
import { knownCommand } from '../cli/cli-parse.js';
import { isHumanCliCommand } from './cli-telemetry.js';
import { createTelemetry } from './telemetry.js';
import { describeToolParams } from './argument-shape.js';
import { readFileSync } from 'node:fs';

describe('cli_command_run reports human intent, and only that', () => {
  it('does not fire for `mcp` — the agent spawning its transport is not a typed command', () => {
    expect(isHumanCliCommand('mcp')).toBe(false);
  });

  it('still fires for the commands a person actually runs', () => {
    for (const cmd of ['status', 'init', 'verify', 'gate', 'doctor', 'stop', 'update']) {
      expect(isHumanCliCommand(cmd), cmd).toBe(true);
    }
  });

  it('`serve` still counts — a human typing it is a real, deliberate act', () => {
    // Unlike `mcp`, nothing spawns `serve` on a person's behalf.
    expect(isHumanCliCommand('serve')).toBe(true);
  });

  it('an unrecognised command still reports, as `unknown`', () => {
    expect(isHumanCliCommand(knownCommand('flurb'))).toBe(true);
  });
});

describe('sessionId means a daemon run, and nothing else', () => {
  it('daemon-hosted events are session-scoped', () => {
    for (const kind of [
      TelemetryEventKind.DAEMON_STARTED,
      TelemetryEventKind.DAEMON_STOPPED,
      TelemetryEventKind.SESSION_PROGRESS,
      TelemetryEventKind.MCP_CLIENT_CONNECTED,
      TelemetryEventKind.PROJECT_PROFILED,
      TelemetryEventKind.VERIFICATION_COMPLETED,
      TelemetryEventKind.BUG_FOUND,
    ]) {
      expect(isSessionScoped(kind), kind).toBe(true);
    }
  });

  it('one-shot CLI events are NOT — they invent a session that joins to nothing', () => {
    for (const kind of [
      TelemetryEventKind.CLI_COMMAND_RUN,
      TelemetryEventKind.RETICLE_INSTALLED,
      TelemetryEventKind.VERSION_CHANGED,
      TelemetryEventKind.IDENTIFIED,
      TelemetryEventKind.INIT_COMPLETED,
    ]) {
      expect(isSessionScoped(kind), kind).toBe(false);
    }
  });
});

describe('the wire reflects it', () => {
  it('a CLI event carries no sessionId; a daemon event does', async () => {
    const seen: { event: string; properties: Record<string, unknown> }[] = [];
    const impl = (
      _url: string,
      init?: { body?: unknown },
    ): Promise<{ ok: boolean; status: number }> => {
      const parsed = JSON.parse(String(init?.body)) as {
        batch: { event: string; properties: Record<string, unknown> }[];
      };
      seen.push(...parsed.batch);
      return Promise.resolve({ ok: true, status: 200 });
    };
    const t = createTelemetry({
      version: '9.9.9',
      env: { RETICLE_TELEMETRY_URL: 'http://example.test', RETICLE_TELEMETRY_KEY: 'phc_test' },
      cwd: '/tmp/hygiene-proj',
      now: () => 1,
      fetchImpl: impl as unknown as typeof fetch,
    });
    await t.emit(TelemetryEventKind.CLI_COMMAND_RUN, { command: 'status' });
    await t.emit(TelemetryEventKind.DAEMON_STARTED);
    const cli = seen.find((e) => e.event === TelemetryEventKind.CLI_COMMAND_RUN);
    const daemon = seen.find((e) => e.event === TelemetryEventKind.DAEMON_STARTED);
    expect(cli?.properties.sessionId, 'a one-shot command is not a session').toBeUndefined();
    expect(cli?.properties.$session_id).toBeUndefined();
    expect(cli?.properties.actor, 'human by definition once mcp is excluded').toBeUndefined();
    expect(typeof daemon?.properties.sessionId).toBe('string');
  });
});

describe('the tool-parameter histogram counts only informative parameters', () => {
  it('drops sessionId — every tool takes it, so it answers nothing', () => {
    expect(describeToolParams({ sessionId: 's1', ref: 'e4', timeout_ms: 3000 })).toEqual([
      'ref',
      'timeout_ms',
    ]);
  });

  it('and still records the ones that say how a tool is used', () => {
    expect(describeToolParams({ sessionId: 's1', until: {} })).toEqual(['until']);
  });
});

describe('the install is reported whichever command ran first', () => {
  it('`mcp` does not fire cli_command_run, but MUST NOT suppress reticle_installed', () => {
    // The top of every funnel. On most machines the first-ever contact is the agent spawning
    // `reticle mcp`, and the human-command filter sits in the same function — so putting the filter
    // first meant a real sweep produced 15 init_completed and ZERO reticle_installed.
    const source = readFileSync(new URL('./cli-telemetry.ts', import.meta.url), 'utf8');
    const installedAt = source.indexOf('RETICLE_INSTALLED');
    const filterAt = source.indexOf('if (!isHumanCliCommand(command)) return;');
    expect(installedAt).toBeGreaterThan(0);
    expect(filterAt).toBeGreaterThan(0);
    expect(installedAt, 'the install must be emitted BEFORE the human-command filter').toBeLessThan(
      filterAt,
    );
  });
});
