import { describe, expect, it } from 'vitest';
import { AutomationHint } from '@reticlehq/core/telemetry';
import { resolveAutomationHint } from './automation-hint.js';

const noFiles = (): boolean => false;

describe('resolveAutomationHint', () => {
  it('says nothing about an ordinary interactive machine', () => {
    expect(resolveAutomationHint({ env: {}, fileExists: noFiles })).toBeUndefined();
  });

  it('names a container when the runtime marker is on disk', () => {
    expect(resolveAutomationHint({ env: {}, fileExists: (p) => '/.dockerenv' === p })).toBe(
      AutomationHint.CONTAINER,
    );
  });

  it('names a hosted workspace from its own declared marker', () => {
    expect(
      resolveAutomationHint({
        env: { GITPOD_WORKSPACE_ID: 'w-1' },
        fileExists: noFiles,
      }),
    ).toBe(AutomationHint.HOSTED_WORKSPACE);
  });

  it('never reads the terminal: an MCP stdio process has none and is still a person', () => {
    // `no_tty` fired for every MCP stdio process, so it separated nothing from anything.
    expect(resolveAutomationHint({ env: {}, fileExists: noFiles })).toBeUndefined();
  });

  it('names a CI runner from the vendor variable when CI itself is not set', () => {
    expect(resolveAutomationHint({ env: { GITHUB_ACTIONS: 'true' }, fileExists: noFiles })).toBe(
      AutomationHint.CI_RUNNER,
    );
    expect(resolveAutomationHint({ env: { JENKINS_URL: 'x' }, fileExists: noFiles })).toBe(
      AutomationHint.CI_RUNNER,
    );
  });

  it('names a hosted agent sandbox from its own declared marker, ahead of the container it runs in', () => {
    expect(
      resolveAutomationHint({
        env: { CLAUDE_CODE_REMOTE: 'true' },
        fileExists: (p) => '/.dockerenv' === p,
      }),
    ).toBe(AutomationHint.AGENT_SANDBOX);
  });

  it('prefers the specific signal over the weak one when both are present', () => {
    expect(
      resolveAutomationHint({
        env: { CODESPACES: 'true' },
        fileExists: (p) => '/.dockerenv' === p,
      }),
    ).toBe(AutomationHint.CONTAINER);
  });

  it('ignores a marker that is present but empty', () => {
    expect(resolveAutomationHint({ env: { CODESPACES: '' }, fileExists: noFiles })).toBeUndefined();
  });
});
