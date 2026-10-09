import { describe, it, expect } from 'vitest';
import { buildNodeIo, RUNNABLE_COMMANDS } from './node-io.js';
import { SILENT_HOST } from './host.js';
import { PackageManager } from './detect/detect.js';
import {
  claudeAddCommand,
  claudeAvailableProbe,
  codexAddCommand,
  codexAvailableProbe,
} from './register/mcp.js';
import { installCommandParts } from './detect/detect.js';

describe('the commands init is allowed to run', () => {
  it('covers every package manager an install step can name', () => {
    for (const pm of Object.values(PackageManager)) {
      expect(RUNNABLE_COMMANDS).toContain(installCommandParts(pm, ['@reticlehq/react']).command);
    }
  });

  it('covers the MCP registration command and its availability probe', () => {
    expect(RUNNABLE_COMMANDS).toContain(claudeAddCommand().command);
    expect(RUNNABLE_COMMANDS).toContain(claudeAvailableProbe().command);
  });

  // Found in review of #1238: the Codex registration was tested against a fake machine that runs
  // anything, so the production `io` threw "refused to run codex" at the probe and the whole
  // feature never ran outside a test.
  it('covers the Codex registration command and its availability probe', () => {
    expect(RUNNABLE_COMMANDS).toContain(codexAddCommand().command);
    expect(RUNNABLE_COMMANDS).toContain(codexAvailableProbe().command);
  });

  it('lets the real io probe for the Codex CLI instead of throwing', () => {
    const io = buildNodeIo(process.cwd(), SILENT_HOST);
    const probe = codexAvailableProbe();
    expect(() => io.probe(probe.command, probe.args)).not.toThrow();
  });

  // The guard exists because `shellOpt` spawns through a shell on Windows, where the command name
  // is parsed rather than executed. It must refuse rather than report a failed run.
  it('refuses a command outside the set instead of returning false', () => {
    const io = buildNodeIo(process.cwd(), SILENT_HOST);
    expect(() => io.exec('sh', ['-c', 'echo pwned'])).toThrow(/refused to run/);
    expect(() => io.probe('sh', ['-c', 'echo pwned'])).toThrow(/refused to run/);
  });
});
