#!/usr/bin/env node
/**
 * Reticle Enterprise license issuer — the ISSUER (Reticle) side. Mints offline Ed25519 license keys that
 * `reticle license` / assertEnterprise verify locally on a customer's machine. Keep the PRIVATE key secret;
 * never commit or ship it. The PUBLIC key is what gets baked into a release (RETICLE_LICENSE_PUBLIC_KEY).
 *
 *   node scripts/issue-license.mjs keygen
 *       → prints a fresh keypair: ship the public PEM, vault the private PEM.
 *
 *   RETICLE_LICENSE_PRIVATE_KEY="$(cat issuer-private.pem)" \
 *   node scripts/issue-license.mjs sign --org "Acme" --plan enterprise --days 365 [--features sso,audit]
 *       → prints the customer's RETICLE_LICENSE_KEY, and the license id (lid) to record against them.
 *
 * Every issued key is appended to a local LEDGER (--ledger, or RETICLE_LICENSE_LEDGER, default
 * ~/.reticle/licenses.jsonl). Nothing else records what we issued: the key itself is stateless and the
 * runtime never phones home, so an unrecorded key is one we can neither attribute, renew, nor answer a
 * question about. The ledger holds a FINGERPRINT rather than the key (a lost key is re-signed with the
 * same --lid, so there is no reason to keep the secret around), and it is local to whichever machine
 * signed: sync it somewhere the team shares before there is more than one customer in it.
 *
 * The lid is minted here and is the ONLY stable handle on a customer — `--org` is a display name, so it
 * collides and it changes. RECORD IT when you issue: usage is attributed by lid, and a key you hand over
 * without writing its lid down is usage you cannot attribute to anyone. Renewing an existing customer?
 * Pass their original `--lid` so the renewal continues the same history instead of starting a new one.
 */

import { generateKeyPairSync, createPrivateKey, randomUUID, createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { signLicenseKey } from '../packages/server/dist/license/license.js';

const [cmd, ...rest] = process.argv.slice(2);

function flag(name) {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}

if (cmd === 'keygen') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.stdout.write('# PUBLIC KEY — bake into the release as RETICLE_LICENSE_PUBLIC_KEY:\n');
  process.stdout.write(publicKey.export({ type: 'spki', format: 'pem' }).toString());
  process.stdout.write('\n# PRIVATE KEY — keep SECRET (vault). Used only to sign keys:\n');
  process.stdout.write(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  process.exit(0);
}

if (cmd === 'sign') {
  const pem = process.env.RETICLE_LICENSE_PRIVATE_KEY;
  if (!pem) {
    process.stderr.write('error: set RETICLE_LICENSE_PRIVATE_KEY (the issuer private key PEM)\n');
    process.exit(1);
  }
  const org = flag('org');
  const plan = flag('plan') ?? 'enterprise';
  const days = Number(flag('days') ?? '365');
  if (!org) {
    process.stderr.write('error: --org is required\n');
    process.exit(1);
  }
  const featuresArg = flag('features');
  const lid = flag('lid') ?? randomUUID();
  const payload = {
    lid,
    org,
    plan,
    exp: Date.now() + days * 24 * 60 * 60 * 1000,
    ...(featuresArg ? { features: featuresArg.split(',').map((s) => s.trim()) } : {}),
  };
  const key = signLicenseKey(payload, createPrivateKey(pem));

  const ledgerPath =
    flag('ledger') ??
    process.env.RETICLE_LICENSE_LEDGER ??
    join(homedir(), '.reticle', 'licenses.jsonl');
  const record = {
    lid,
    org,
    plan,
    features: payload.features ?? null,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(payload.exp).toISOString(),
    // Identifies a key without storing one. Enough to match a key a customer pastes into a support
    // thread against what we actually issued.
    keyFingerprint: createHash('sha256').update(key).digest('hex').slice(0, 16),
  };
  try {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`);
  } catch (error) {
    // Never lose the key over a ledger failure: it is already signed and about to be printed. Say so
    // loudly instead, because an unrecorded key is one nobody can attribute or renew later.
    process.stderr.write(
      `# WARNING: could not write the ledger at ${ledgerPath}: ${error.message}\n`,
    );
    process.stderr.write('# RECORD THIS BY HAND before sending the key.\n');
  }

  process.stderr.write(
    `# lid: ${lid}  (org: ${org}, plan: ${plan}, expires: ${new Date(payload.exp).toISOString()})\n` +
      `# fingerprint: ${record.keyFingerprint}  ·  ledger: ${ledgerPath}\n` +
      "# Reuse this lid on renewal so the customer's usage history stays continuous.\n",
  );
  process.stdout.write(`${key}\n`);
  process.exit(0);
}

process.stderr.write(
  'usage: issue-license.mjs <keygen | sign --org X [--plan enterprise] [--days 365] [--features a,b] [--lid <existing-id>] [--ledger <path>]>\n',
);
process.exit(1);
