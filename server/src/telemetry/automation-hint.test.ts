import { describe, expect, it } from 'vitest';
import { AutomationHint } from '@reticlehq/core/telemetry';
import { isServerProcess, resolveAutomationHint } from './automation-hint.js';

const noFiles = (): boolean => false;

describe('resolveAutomationHint', () => {
  it('says nothing about an ordinary interactive machine', () => {
    expect(resolveAutomationHint({ env: {}, fileExists: noFiles, hasTty: true })).toBeUndefined();
  });

  it('names a container when the runtime marker is on disk', () => {
    expect(
      resolveAutomationHint({ env: {}, fileExists: (p) => '/.dockerenv' === p, hasTty: true }),
    ).toBe(AutomationHint.CONTAINER);
  });

  it('names a hosted workspace from its own declared marker', () => {
    expect(
      resolveAutomationHint({
        env: { GITPOD_WORKSPACE_ID: 'w-1' },
        fileExists: noFiles,
        hasTty: true,
      }),
    ).toBe(AutomationHint.HOSTED_WORKSPACE);
  });

  it('falls back to no terminal — the weakest signal, and last', () => {
    expect(resolveAutomationHint({ env: {}, fileExists: noFiles, hasTty: false })).toBe(
      AutomationHint.NO_TTY,
    );
  });

  it('prefers the specific signal over the weak one when both are present', () => {
    expect(
      resolveAutomationHint({
        env: { CODESPACES: 'true' },
        fileExists: (p) => '/.dockerenv' === p,
        hasTty: false,
      }),
    ).toBe(AutomationHint.CONTAINER);
  });

  it('does not call a daemon or an MCP server headless: it never has a terminal, by design', () => {
    expect(
      resolveAutomationHint({ env: {}, fileExists: noFiles, hasTty: false, serverProcess: true }),
    ).toBeUndefined();
  });

  it.each([
    [[], true],
    [['serve'], true],
    [['serve', '--port', '4400'], true],
    [['mcp'], true],
    [['--port', '4400'], true],
    [['init'], false],
    [['status'], false],
  ])('treats argv %j as a server process: %s', (argv, expected) => {
    expect(isServerProcess(argv)).toBe(expected);
  });

  it('ignores a marker that is present but empty', () => {
    expect(
      resolveAutomationHint({ env: { CODESPACES: '' }, fileExists: noFiles, hasTty: true }),
    ).toBeUndefined();
  });
});
