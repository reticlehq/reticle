import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { LicenseActivation } from '@reticlehq/core';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelemetryEventKind } from '@reticlehq/core';
import { licenseFacts } from './license-activation.js';
import { createTelemetry, POSTHOG_GROUP_ORGANIZATION } from './telemetry.js';
import { LICENSE_KEY_ENV, LICENSE_PUBLIC_KEY_ENV, signLicenseKey } from '../license/license.js';

const NOW = 1_700_000_000_000;
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBKEY_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const LID = 'aa1bdcc5-2db3-43e5-b46c-517734936c5d';

const key = (exp: number, org = 'Northwind Bank') =>
  signLicenseKey({ lid: LID, org, plan: 'enterprise', exp }, privateKey);
const licensed = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  [LICENSE_PUBLIC_KEY_ENV]: PUBKEY_PEM,
  ...over,
});

describe('licenseFacts', () => {
  it('reports id and status for an active license, and nothing the ledger already holds', () => {
    // The plan is NOT sent. It is keyed by this same lid in the issuance ledger, so putting it on
    // every event from every machine forever pays a per-event cost to carry something one local
    // file already knows, and the join that resolves the lid to a company resolves the plan with it.
    const facts = licenseFacts(NOW, licensed({ [LICENSE_KEY_ENV]: key(NOW + 100_000) }));
    expect(facts).toEqual({
      licenseId: LID,
      licenseStatus: LicenseActivation.ACTIVE,
    });
  });

  it('NEVER puts the organisation name on the wire', () => {
    const facts = licenseFacts(
      NOW,
      licensed({ [LICENSE_KEY_ENV]: key(NOW + 100_000, 'Northwind') }),
    );
    expect(JSON.stringify(facts)).not.toContain('Northwind');
  });

  it('names the customer whose key lapsed, not merely that one did', () => {
    // The renewal signal, and it has to carry identity to be one. A fleet rehearsal through a
    // packaged release showed the lapsed customer arriving UNATTRIBUTABLE: the status said a licence
    // had run out and nothing said whose. An expired key is still SIGNED, so its id is exactly as
    // trustworthy as it was the day before; only the clock moved.
    const facts = licenseFacts(NOW, licensed({ [LICENSE_KEY_ENV]: key(NOW - 1) }));
    expect(facts.licenseStatus).toBe(LicenseActivation.EXPIRED);
    expect(facts.licenseId).toBe(LID);
  });

  it('reports missing and invalid distinctly', () => {
    expect(licenseFacts(NOW, licensed()).licenseStatus).toBe(LicenseActivation.MISSING);
    expect(licenseFacts(NOW, licensed({ [LICENSE_KEY_ENV]: 'garbage' })).licenseStatus).toBe(
      LicenseActivation.INVALID,
    );
  });

  it('says NOTHING on a build with no issuer key baked — every OSS install', () => {
    // Absence already means "not a licensed build". Emitting `eval` would add three properties to the
    // dominant population to say so at a cost.
    expect(licenseFacts(NOW, {})).toEqual({});
  });

  it('reports a mis-built production release rather than staying silent about it', () => {
    // Production with no resolvable issuer key is a release whose gate is off. That is the one
    // no-key case worth hearing about, and describeLicense already distinguishes it from eval.
    expect(licenseFacts(NOW, { NODE_ENV: 'production' }).licenseStatus).toBe(
      LicenseActivation.INVALID,
    );
  });

  it('uses the EVENT clock, so a mid-session expiry is visible on the event it expires on', () => {
    const env = licensed({ [LICENSE_KEY_ENV]: key(NOW + 1_000) });
    expect(licenseFacts(NOW, env).licenseStatus).toBe(LicenseActivation.ACTIVE);
    expect(licenseFacts(NOW + 2_000, env).licenseStatus).toBe(LicenseActivation.EXPIRED);
  });
});

/**
 * The group that lets PostHog aggregate a customer instead of a machine. Written against the FILE
 * SINK rather than a mocked sender, because the sink is built by the same code path as the wire
 * payload: what this asserts is literally what would have been sent.
 */
describe('a licensed event belongs to an organisation group', () => {
  const PUBKEY_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  const captureFor = async (env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> => {
    const dir = mkdtempSync(join(tmpdir(), 'reticle-groups-'));
    const file = join(dir, 'events.jsonl');
    const telemetry = createTelemetry({
      version: '0.0.0-test',
      // Outside the checkout: in a Reticle source tree the emitter carries feedback and nothing
      // else, so a cli_command_run here would be suppressed and the file would stay empty.
      cwd: dir,
      // Same literals the sibling local-sink test uses; Env is module-private on purpose.
      env: { ...env, RETICLE_TELEMETRY_FILE: file, RETICLE_TELEMETRY_KEY: 'k' },
    });
    // Awaited: the write happens inside emit, so reading the file first races it.
    await telemetry.emit(TelemetryEventKind.CLI_COMMAND_RUN, { command: 'license' });
    const raw = readFileSync(file, 'utf8').trim();
    if ('' === raw) throw new Error('nothing was written to the sink');
    const line = raw.split('\n').pop() ?? '{}';
    rmSync(dir, { recursive: true, force: true });
    return JSON.parse(line) as Record<string, unknown>;
  };

  it('sends $groups keyed on the licence id, and never the org name', async () => {
    const capture = await captureFor({
      [LICENSE_PUBLIC_KEY_ENV]: PUBKEY_PEM,
      [LICENSE_KEY_ENV]: key(NOW + 100_000, 'Northwind Bank'),
    });
    const props = capture['properties'] as Record<string, unknown>;
    expect(props['$groups']).toEqual({ [POSTHOG_GROUP_ORGANIZATION]: LID });
    // The name reaches PostHog only if WE push it from the ledger, never from a customer's machine.
    expect(JSON.stringify(capture)).not.toContain('Northwind');
  });

  it('sends no group at all when there is no licence', async () => {
    // An empty or placeholder key would mint a phantom "no org" bucket that every OSS install falls
    // into, and it would be the largest group on the dashboard.
    const capture = await captureFor({});
    const props = capture['properties'] as Record<string, unknown>;
    expect(props['$groups']).toBeUndefined();
  });
});
