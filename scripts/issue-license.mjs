#!/usr/bin/env node
/**
 * Iris Enterprise license issuer — the ISSUER (Syrin) side. Mints offline Ed25519 license keys that
 * `iris license` / assertEnterprise verify locally on a customer's machine. Keep the PRIVATE key secret;
 * never commit or ship it. The PUBLIC key is what gets baked into a release (IRIS_LICENSE_PUBLIC_KEY).
 *
 *   node scripts/issue-license.mjs keygen
 *       → prints a fresh keypair: ship the public PEM, vault the private PEM.
 *
 *   IRIS_LICENSE_PRIVATE_KEY="$(cat issuer-private.pem)" \
 *   node scripts/issue-license.mjs sign --org "Acme" --plan enterprise --days 365 [--features sso,audit]
 *       → prints the customer's IRIS_LICENSE_KEY.
 */

import { generateKeyPairSync, createPrivateKey } from 'node:crypto';
import { signLicenseKey } from '../packages/server/dist/license/license.js';

const [cmd, ...rest] = process.argv.slice(2);

function flag(name) {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}

if (cmd === 'keygen') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  process.stdout.write('# PUBLIC KEY — bake into the release as IRIS_LICENSE_PUBLIC_KEY:\n');
  process.stdout.write(publicKey.export({ type: 'spki', format: 'pem' }).toString());
  process.stdout.write('\n# PRIVATE KEY — keep SECRET (vault). Used only to sign keys:\n');
  process.stdout.write(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  process.exit(0);
}

if (cmd === 'sign') {
  const pem = process.env.IRIS_LICENSE_PRIVATE_KEY;
  if (!pem) {
    process.stderr.write('error: set IRIS_LICENSE_PRIVATE_KEY (the issuer private key PEM)\n');
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
  const payload = {
    org,
    plan,
    exp: Date.now() + days * 24 * 60 * 60 * 1000,
    ...(featuresArg ? { features: featuresArg.split(',').map((s) => s.trim()) } : {}),
  };
  const key = signLicenseKey(payload, createPrivateKey(pem));
  process.stdout.write(`${key}\n`);
  process.exit(0);
}

process.stderr.write(
  'usage: issue-license.mjs <keygen | sign --org X [--plan enterprise] [--days 365] [--features a,b]>\n',
);
process.exit(1);
