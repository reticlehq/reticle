import { describe, expect, it } from 'vitest';
import { PackageManager } from '@/detect/detect.js';
import { installFailureHint } from './install-hint.js';

describe('installFailureHint', () => {
  /**
   * Reported in #683: a pnpm checkout whose node_modules is symlinked into another checkout's
   * `.pnpm` store (a git worktree, or an A/B harness) makes `pnpm add` die with
   * ERR_PNPM_UNEXPECTED_VIRTUAL_STORE. The hint named only ERR_PNPM_NO_MATURE_MATCHING_VERSION,
   * so a symlinked-store user got guidance that did not match what they were seeing.
   */
  it('names ERR_PNPM_UNEXPECTED_VIRTUAL_STORE and points at installing in the worktree first', () => {
    const hint = installFailureHint(PackageManager.PNPM);
    expect(hint).toContain('ERR_PNPM_UNEXPECTED_VIRTUAL_STORE');
    expect(hint).toContain('pnpm install');
  });

  it('still names ERR_PNPM_NO_MATURE_MATCHING_VERSION (no regression)', () => {
    const hint = installFailureHint(PackageManager.PNPM);
    expect(hint).toContain('ERR_PNPM_NO_MATURE_MATCHING_VERSION');
    expect(hint).toContain('minimumReleaseAgeExclude');
  });

  it('does not mention pnpm-specific error codes for a non-pnpm package manager', () => {
    const hint = installFailureHint(PackageManager.NPM);
    expect(hint).not.toContain('ERR_PNPM');
  });

  /**
   * Reported from the field (#1149): a corepack-only machine has no bare `pnpm` on PATH. The hint
   * used to print `pnpm config set …` and `pnpm install` regardless, handing that reader a remedy
   * that fails exactly the way the original install did.
   */
  it('prints the resolved invocation, not a bare pnpm, on a corepack-only machine', () => {
    const hint = installFailureHint(PackageManager.PNPM, 'corepack pnpm');
    expect(hint).toContain('corepack pnpm config set minimumReleaseAgeExclude');
    expect(hint).toContain('corepack pnpm install');
    expect(hint).toContain('corepack pnpm add -D --config.virtual-store-dir');
  });
});
