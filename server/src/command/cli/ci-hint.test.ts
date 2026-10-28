import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutomationHint } from '@reticlehq/core/telemetry';
import {
  CI_HINT_SILENCE_ENV,
  CI_HINT_URL,
  ciHintLine,
  writeCiHint,
  type CiHintInput,
} from './ci-hint.js';

const base: CiHintInput = {
  env: {},
  automation: AutomationHint.CI_RUNNER,
  interactive: false,
  machineOutput: false,
  currentVersion: '3.9.0',
  latestVersion: undefined,
};

describe('the one line for a CI run of gate, verify or affected', () => {
  it('names the pull request check and the page, on a CI runner', () => {
    const line = ciHintLine(base);
    expect(line).toBeDefined();
    expect(line).toContain(CI_HINT_URL);
    expect(line).toMatch(/replay/);
    expect(line).toMatch(/history/);
    expect(line).toMatch(/merge/);
  });

  it('is one line', () => {
    expect(ciHintLine(base)).not.toMatch(/\n/);
  });

  it('also prints in a container', () => {
    expect(ciHintLine({ ...base, automation: AutomationHint.CONTAINER })).toBeDefined();
  });

  it('prints nothing when the run does not look like CI or a container', () => {
    expect(ciHintLine({ ...base, automation: undefined })).toBeUndefined();
    expect(ciHintLine({ ...base, automation: AutomationHint.HOSTED_WORKSPACE })).toBeUndefined();
    expect(ciHintLine({ ...base, automation: AutomationHint.AGENT_SANDBOX })).toBeUndefined();
  });

  it('prints nothing in an interactive terminal', () => {
    expect(ciHintLine({ ...base, interactive: true })).toBeUndefined();
  });

  it('prints nothing in a machine output mode', () => {
    expect(ciHintLine({ ...base, machineOutput: true })).toBeUndefined();
  });

  it('prints nothing when the env var turns it off', () => {
    expect(ciHintLine({ ...base, env: { [CI_HINT_SILENCE_ENV]: '1' } })).toBeUndefined();
  });

  it('still prints when the env var is set to 0', () => {
    expect(ciHintLine({ ...base, env: { [CI_HINT_SILENCE_ENV]: '0' } })).toBeDefined();
  });

  it('says the engine is a major version behind, instead, when it is', () => {
    const line = ciHintLine({ ...base, currentVersion: '2.14.0', latestVersion: '3.9.0' });
    expect(line).toContain('2.14.0');
    expect(line).toContain('3.9.0');
    expect(line).toMatch(/major version behind/);
    expect(line).toContain(CI_HINT_URL);
    expect(line).not.toMatch(/\n/);
  });

  it('gives the usual line when the latest is only a minor version ahead', () => {
    const line = ciHintLine({ ...base, currentVersion: '3.8.0', latestVersion: '3.9.0' });
    expect(line).toBe(ciHintLine(base));
  });
});

describe('writeCiHint', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes exactly one line, and makes no network call', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const written: string[] = [];
    writeCiHint({
      automation: AutomationHint.CI_RUNNER,
      machineOutput: false,
      ports: {
        env: {},
        interactive: () => false,
        latestVersion: () => undefined,
        write: (text) => written.push(text),
      },
    });
    expect(written).toHaveLength(1);
    expect(written[0]?.endsWith('\n')).toBe(true);
    expect(written[0]?.trimEnd()).not.toMatch(/\n/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('writes nothing when the line does not apply', () => {
    const written: string[] = [];
    writeCiHint({
      automation: AutomationHint.CI_RUNNER,
      machineOutput: true,
      ports: {
        env: {},
        interactive: () => false,
        latestVersion: () => undefined,
        write: (text) => written.push(text),
      },
    });
    expect(written).toHaveLength(0);
  });
});
