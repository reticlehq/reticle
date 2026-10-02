import { describe, it, expect } from 'vitest';
import { buildNodeIo, RUNNABLE_COMMANDS } from './node-io.js';
import { SILENT_HOST } from './host.js';
import { PackageManager } from './detect/detect.js';
import { claudeAddCommand, claudeAvailableProbe } from './register/mcp.js';
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

  // The guard exists because `shellOpt` spawns through a shell on Windows, where the command name
  // is parsed rather than executed. It must refuse rather than report a failed run.
  it('refuses a command outside the set instead of returning false', () => {
    const io = buildNodeIo(process.cwd(), SILENT_HOST);
    expect(() => io.exec('sh', ['-c', 'echo pwned'])).toThrow(/refused to run/);
    expect(() => io.probe('sh', ['-c', 'echo pwned'])).toThrow(/refused to run/);
  });
});
