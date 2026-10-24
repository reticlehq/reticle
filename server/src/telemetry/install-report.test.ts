import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InstallSource } from '@reticlehq/core/telemetry';
import { claimInstallReport } from './cli-telemetry.js';
import {
  INSTALL_SOURCE_ENV,
  rememberInstallSource,
  resolveInstallSource,
} from './install-source.js';

/**
 * An agent often runs `--version` or `--help` before anything else, with no install marker. When
 * the install was reported on that probe, its source read `unknown` for good, and the marked command
 * that came next could not correct it.
 */
describe('the install is reported on the first real command, not on a probe', () => {
  const stateDir = (): string => mkdtempSync(join(tmpdir(), 'reticle-install-report-'));

  it('a probe on a new machine does not report the install', () => {
    const dir = stateDir();
    for (const probe of ['version', 'help', 'telemetry']) {
      expect(claimInstallReport(probe, true, dir), probe).toBe(false);
    }
  });

  it('the first real command after a probe reports it once', () => {
    const dir = stateDir();
    expect(claimInstallReport('version', true, dir)).toBe(false);
    // The id file now exists, so the next process is not a first run.
    expect(claimInstallReport('init', false, dir)).toBe(true);
    expect(claimInstallReport('init', false, dir)).toBe(false);
  });

  it('a real first command reports it at once', () => {
    expect(claimInstallReport('mcp', true, stateDir())).toBe(true);
  });

  it('a machine that reported its install before never reports it again', () => {
    expect(claimInstallReport('init', false, stateDir())).toBe(false);
  });

  it('the report carries the source a later marked command declared', () => {
    const dir = stateDir();
    expect(claimInstallReport('version', true, dir)).toBe(false);
    rememberInstallSource({ [INSTALL_SOURCE_ENV]: 'npx_skill' }, dir);
    expect(claimInstallReport('init', false, dir)).toBe(true);
    expect(resolveInstallSource({}, dir)).toBe(InstallSource.NPX_SKILL);
  });
});
