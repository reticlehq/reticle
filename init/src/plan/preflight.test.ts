import { describe, expect, it } from 'vitest';
import { preflight, type PreflightIo } from './preflight.js';

/**
 * Two conditions that make every later phase fail, checked before anything is written.
 *
 * Both were in setup/reticle.mjs and neither survived the port into `init`. Without them the
 * failures arrive far from their cause: EACCES as a stack trace at phase four, and `spawn pnpm
 * ENOENT` surfacing inside "the dev server exited" — which sends the reader into their own dev
 * script hunting a bug that is not there.
 */
const io = (over: Partial<PreflightIo> = {}): PreflightIo => ({
  cwd: () => '/app',
  canWrite: () => true,
  probe: () => true,
  ...over,
});

describe('preflight resolves the invocation, or refuses what cannot possibly work', () => {
  it('passes a writable project with the tools it names', () => {
    expect(preflight(io(), 'npm')).toEqual({ command: 'npm' });
  });

  it('names an unwritable checkout, and what setup needs to write', () => {
    const result = preflight(io({ canWrite: () => false }), 'npm');
    expect(result.refusal).toContain('not writable');
    expect(result.refusal).toContain('/app');
  });

  // The lockfile says which package manager the PROJECT uses. It says nothing about whether the
  // machine has it, and a pnpm-lock.yaml on an npm-only box is an ordinary Monday.
  it('names the RESOLVED package manager when the machine lacks it', () => {
    const result = preflight(io({ probe: (cmd) => 'pnpm' !== cmd && 'corepack' !== cmd }), 'pnpm');
    expect(result.refusal).toContain('pnpm is not installed');
  });

  it('says nothing when the machine has it, and hands back the bare command', () => {
    expect(preflight(io(), 'pnpm')).toEqual({ command: 'pnpm' });
  });

  it('recognises yarn and bun too', () => {
    for (const pm of ['yarn', 'bun'] as const) {
      const result = preflight(io({ probe: (cmd) => pm !== cmd && 'corepack' !== cmd }), pm);
      expect(result.refusal).toContain(`${pm} is not installed`);
    }
  });

  // npm ships with node. Refusing for its absence would refuse on a machine that is fine.
  it('does not check for npm, which comes with node', () => {
    expect(preflight(io({ probe: () => false }), 'npm')).toEqual({ command: 'npm' });
  });

  /**
   * The manager is the one init RESOLVED, never a raw lockfile check.
   *
   * An inherited `pnpm-lock.yaml` at a monorepo root does NOT mean the app in `frontend/` uses pnpm:
   * that app's own installed tree outranks an ancestor lockfile, and init already works this out.
   * Re-deriving it here from `exists('pnpm-lock.yaml')` refused a scaffold the install gate proves
   * must succeed — an npm app under a pnpm monorepo, on a machine with no pnpm.
   */
  it('does not refuse an npm app that merely sits under a pnpm monorepo', () => {
    expect(preflight(io({ probe: (cmd) => 'pnpm' !== cmd }), 'npm')).toEqual({ command: 'npm' });
  });

  // Writability first: on a read-only checkout nothing else matters, and running a subprocess to
  // find that out is slower and noisier than one access check.
  it('reports unwritable before anything else', () => {
    const result = preflight(io({ canWrite: () => false, probe: () => false }), 'pnpm');
    expect(result.refusal).toContain('not writable');
  });

  // The recovery has to name a flag init actually has: it takes --url, never --dev-cmd.
  it('points at a flag that exists', () => {
    const result = preflight(io({ probe: (cmd) => 'pnpm' !== cmd && 'corepack' !== cmd }), 'pnpm');
    expect(result.refusal).toContain('--url');
    expect(result.refusal).not.toContain('--dev-cmd');
  });
});

/**
 * A corepack-managed pnpm is not ENOENT — the probe just asked the wrong binary.
 *
 * Reported from the field (#1149): `init` on Windows, in a project whose `packageManager` field
 * pins pnpm, refuses with "pnpm is not installed on this machine" even though
 * `corepack pnpm --version` succeeds. The suggested remedy, `corepack enable`, fails with `EPERM`
 * on Windows because its shims go into `C:\Program Files\nodejs`, which needs an elevated shell —
 * so the refusal sends a corepack-managed user in a circle just as surely as the `--url` one did.
 */
describe('a corepack-managed package manager is not a missing one', () => {
  // The bare binary is gone; corepack can still run it.
  const corepackOnly = io({
    probe: (command, args) => 'corepack' === command && 'pnpm' === args[0] && '--version' === args[1],
  });

  it('resolves to the corepack-prefixed command when corepack can run it and the bare binary cannot', () => {
    expect(preflight(corepackOnly, 'pnpm')).toEqual({ command: 'corepack pnpm' });
  });

  it('still refuses when neither the bare binary nor corepack can run it', () => {
    const result = preflight(io({ probe: () => false }), 'pnpm');
    expect(result.refusal).toContain('pnpm is not installed');
  });

  // The refusal used to suggest corepack as an escape hatch right after saying corepack had already
  // failed — sending a corepack-only user in the same circle as the original bug. Both probes failed
  // to get here, so "run it through corepack" cannot be offered as a way out.
  it('does not suggest running it through corepack after corepack has already failed', () => {
    const result = preflight(io({ probe: () => false }), 'pnpm');
    expect(result.refusal).not.toMatch(/run it through corepack/);
  });
});

/**
 * The refusal names `--url` as the way past it, so `--url` has to actually get past it.
 *
 * Reported from the field: `init --app src/ui --url http://localhost:3100` with pnpm absent printed
 * *"this project uses pnpm and pnpm is not installed... or pass --url with the address the app
 * already serves"* — while `--url` WAS passed. The flag was parsed, and then never handed to `init`
 * at all, so it could not have changed this decision. Installing pnpm was the only way forward.
 *
 * This is on the install path, it is the first command a user runs, and the message sends them in a
 * circle: it describes the escape hatch they are already holding.
 *
 * The check is about the DEV SERVER — its whole purpose is to stop `spawn pnpm ENOENT` surfacing
 * inside "the dev server exited". `--url` says the app is already served, so init starts nothing and
 * the condition this guards does not arise. If the dependency install then fails, that is one step
 * reporting ⚠, which is what a step that cannot complete is supposed to do — and is a far better
 * outcome than refusing to write anything at all.
 */
describe('--url gets past the check that advertises it', () => {
  const noPnpm = io({ probe: (command) => 'pnpm' !== command && 'corepack' !== command });

  it('does not refuse for a missing package manager when the app is already served', () => {
    expect(preflight(noPnpm, 'pnpm', { alreadyServed: true })).toEqual({ command: 'pnpm' });
  });

  it('still refuses without --url, which is the case the check was written for', () => {
    const result = preflight(noPnpm, 'pnpm');
    expect(result.refusal).toContain('is not installed');
  });

  it('still refuses an unwritable checkout even with --url', () => {
    // Orthogonal: nothing can be written wherever the app is served from, so this one still stands.
    const result = preflight(io({ canWrite: () => false }), 'pnpm', { alreadyServed: true });
    expect(result.refusal).toContain('not writable');
  });
});
