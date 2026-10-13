import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TelemetryAccountState } from '@reticlehq/core/telemetry';
import { accountEnvelope } from './account-envelope.js';

function fixture(): { home: string; project: string } {
  const base = mkdtempSync(join(tmpdir(), 'reticle-acct-'));
  const home = join(base, 'home');
  const project = join(base, 'app');
  mkdirSync(join(home, '.reticle'), { recursive: true });
  mkdirSync(join(project, '.reticle'), { recursive: true });
  writeFileSync(join(project, 'package.json'), '{}');
  return { home, project };
}
const signIn = (home: string): void =>
  writeFileSync(
    join(home, '.reticle', 'session.json'),
    JSON.stringify({ url: 'https://x', token: 't', orgName: 'Acme Inc', email: 'a@b.co' }),
  );
const link = (project: string, orgId?: string): void =>
  writeFileSync(
    join(project, '.reticle', 'cloud.json'),
    JSON.stringify({
      projectId: 'p1',
      url: 'https://x',
      ...(orgId === undefined ? {} : { orgId }),
    }),
  );

describe('accountEnvelope', () => {
  it('is signed out with nothing on disk', () => {
    const { home, project } = fixture();
    expect(accountEnvelope(project, {}, home)).toEqual({
      accountState: TelemetryAccountState.SIGNED_OUT,
      linked: false,
    });
  });

  it('is signed in from the session file, and carries no name or email', () => {
    const { home, project } = fixture();
    signIn(home);
    const facts = accountEnvelope(project, {}, home);
    expect(facts).toEqual({ accountState: TelemetryAccountState.SIGNED_IN, linked: false });
    expect(JSON.stringify(facts)).not.toMatch(/Acme|a@b/);
  });

  it('is linked, with the workspace id the platform joins on', () => {
    const { home, project } = fixture();
    signIn(home);
    link(project, 'org_123');
    expect(accountEnvelope(project, {}, home)).toEqual({
      accountState: TelemetryAccountState.LINKED,
      linked: true,
      workspaceId: 'org_123',
    });
  });

  it('is linked without a workspace id for a link written before org-scoped slots', () => {
    const { home, project } = fixture();
    link(project);
    expect(accountEnvelope(project, {}, home)).toEqual({
      accountState: TelemetryAccountState.LINKED,
      linked: true,
    });
  });

  it('counts an api key in the environment as signed in', () => {
    const { home, project } = fixture();
    expect(accountEnvelope(project, { RETICLE_API_KEY: 'k' }, home).accountState).toBe(
      TelemetryAccountState.SIGNED_IN,
    );
  });
});
