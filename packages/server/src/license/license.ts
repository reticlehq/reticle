/**
 * Enterprise license-key verification + the assertEnterprise gate. ENTERPRISE CODE (Reticle Enterprise
 * License — see ./LICENSE), not the FSL that covers the rest of the server.
 *
 * Offline + no phone-home (preserves the no-telemetry brand): a key is a signed payload Reticle issues
 * with its private key; this verifies it against the issuer's PUBLIC key with Ed25519. Dev/eval is a
 * no-op (requireLicense:false) so the gate never gets in a contributor's way; only a production-mode
 * caller with requireLicense:true must present a valid, unexpired key. The clock is injected (rule 7).
 *
 * Rules for this directory: the free server must never import from ee/; ee/ depends only on protocol +
 * node + zod. This file imports neither server core nor any sibling outside ee/.
 */

import { createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { z } from 'zod';

/** Outcome of verifying a license key. */
export const LicenseStatus = {
  VALID: 'valid',
  MISSING: 'missing',
  MALFORMED: 'malformed',
  BAD_SIGNATURE: 'bad-signature',
  EXPIRED: 'expired',
} as const;
export type LicenseStatus = (typeof LicenseStatus)[keyof typeof LicenseStatus];

/** The signed claims inside a key. `exp` is epoch ms; `features` (optional) scopes which ee features unlock. */
const LicensePayloadSchema = z.object({
  org: z.string(),
  plan: z.string(),
  exp: z.number(),
  features: z.array(z.string()).optional(),
});
export type LicensePayload = z.infer<typeof LicensePayloadSchema>;

type LicenseCheck =
  | { status: typeof LicenseStatus.VALID; payload: LicensePayload }
  | { status: Exclude<LicenseStatus, typeof LicenseStatus.VALID> };

/** A key is `base64url(payloadJson).base64url(ed25519Signature)`. */
const KEY_SEP = '.';

/** Sign a payload into a license key — the ISSUER side (Reticle's private key). Exposed for the issuer tool + tests. */
export function signLicenseKey(payload: LicensePayload, privateKey: KeyObject): string {
  const json = JSON.stringify(payload);
  const sig = edSign(null, Buffer.from(json, 'utf8'), privateKey);
  return `${Buffer.from(json, 'utf8').toString('base64url')}${KEY_SEP}${sig.toString('base64url')}`;
}

/** Verify a key against the issuer public key. Never throws — returns a structured status. */
export function verifyLicenseKey(
  key: string | undefined,
  publicKey: KeyObject,
  now: number,
): LicenseCheck {
  if (key === undefined || key.length === 0) return { status: LicenseStatus.MISSING };
  const parts = key.split(KEY_SEP);
  if (
    parts.length !== 2 ||
    parts[0] === undefined ||
    parts[1] === undefined ||
    parts[0].length === 0
  ) {
    return { status: LicenseStatus.MALFORMED };
  }

  let json: string;
  let payload: LicensePayload;
  try {
    json = Buffer.from(parts[0], 'base64url').toString('utf8');
    const parsed = LicensePayloadSchema.safeParse(JSON.parse(json));
    if (!parsed.success) return { status: LicenseStatus.MALFORMED };
    payload = parsed.data;
  } catch {
    return { status: LicenseStatus.MALFORMED };
  }

  let signatureOk = false;
  try {
    signatureOk = edVerify(
      null,
      Buffer.from(json, 'utf8'),
      publicKey,
      Buffer.from(parts[1], 'base64url'),
    );
  } catch {
    return { status: LicenseStatus.BAD_SIGNATURE };
  }
  if (!signatureOk) return { status: LicenseStatus.BAD_SIGNATURE };
  if (payload.exp <= now) return { status: LicenseStatus.EXPIRED };
  return { status: LicenseStatus.VALID, payload };
}

/** Thrown when a production-mode enterprise feature is used without a valid license. */
export class EnterpriseLicenseError extends Error {
  readonly feature: string;
  readonly reason: string;
  constructor(feature: string, reason: string) {
    super(
      `Reticle Enterprise feature "${feature}" requires a valid license (${reason}). Contact hey@reticle.ai.`,
    );
    this.name = 'EnterpriseLicenseError';
    this.feature = feature;
    this.reason = reason;
  }
}

/** Context for the gate. requireLicense:false ⇒ dev/eval no-op. publicKey injectable for tests. */
export interface GateContext {
  requireLicense: boolean;
  now: () => number;
  key?: string;
  publicKey?: KeyObject;
}

/** The issuer public key from the environment (set at release / by the operator); undefined if unset. */
function issuerPublicKey(): KeyObject | undefined {
  const pem = process.env['RETICLE_LICENSE_PUBLIC_KEY'];
  if (pem === undefined || pem.length === 0) return undefined;
  try {
    return createPublicKey(pem);
  } catch {
    return undefined;
  }
}

/**
 * Gate an enterprise feature. No-op in dev/eval (requireLicense:false). In production it throws
 * EnterpriseLicenseError unless a valid, unexpired key that covers `feature` is present.
 */
export function assertEnterprise(feature: string, ctx: GateContext): void {
  if (!ctx.requireLicense) return;

  const publicKey = ctx.publicKey ?? issuerPublicKey();
  if (publicKey === undefined) throw new EnterpriseLicenseError(feature, 'no-issuer-key');

  const check = verifyLicenseKey(ctx.key, publicKey, ctx.now());
  if (check.status !== LicenseStatus.VALID) throw new EnterpriseLicenseError(feature, check.status);

  const { features } = check.payload;
  if (features !== undefined && !features.includes(feature)) {
    throw new EnterpriseLicenseError(feature, 'feature-not-licensed');
  }
}

/** Env names that carry the activation: the operator's key, and the issuer public key baked at release. */
export const LICENSE_KEY_ENV = 'RETICLE_LICENSE_KEY';
export const LICENSE_PUBLIC_KEY_ENV = 'RETICLE_LICENSE_PUBLIC_KEY';

/** The human-facing state of enterprise activation on this machine (what `reticle license status` shows). */
interface LicenseReport {
  status: 'active' | 'missing' | 'invalid' | 'expired' | 'eval';
  org?: string;
  plan?: string;
  expiresAt?: number;
  features?: string[];
  detail: string;
}

function loadPublicKey(pem: string | undefined): KeyObject | undefined {
  if (pem === undefined || pem.length === 0) return undefined;
  try {
    return createPublicKey(pem);
  } catch {
    return undefined;
  }
}

/**
 * Resolve activation entirely from the environment — the install mechanism: the release bakes the
 * issuer public key, the operator sets RETICLE_LICENSE_KEY. No public key configured ⇒ evaluation mode
 * (enterprise features run free, dev/test only). Offline, no phone-home.
 */
export function describeLicense(now: number, env: NodeJS.ProcessEnv = process.env): LicenseReport {
  const pem = env[LICENSE_PUBLIC_KEY_ENV];
  if (pem === undefined || pem.length === 0) {
    return {
      status: 'eval',
      detail: 'evaluation mode — enterprise features run free (no issuer key configured)',
    };
  }
  const publicKey = loadPublicKey(pem);
  if (publicKey === undefined)
    return { status: 'invalid', detail: `${LICENSE_PUBLIC_KEY_ENV} is not a valid public key` };

  const check = verifyLicenseKey(env[LICENSE_KEY_ENV], publicKey, now);
  if (check.status === LicenseStatus.VALID) {
    const { org, plan, exp, features } = check.payload;
    return {
      status: 'active',
      org,
      plan,
      expiresAt: exp,
      ...(features !== undefined ? { features } : {}),
      detail: `licensed to ${org} (${plan}), expires ${new Date(exp).toISOString()}`,
    };
  }
  if (check.status === LicenseStatus.MISSING) {
    return {
      status: 'missing',
      detail: `set ${LICENSE_KEY_ENV} to activate enterprise features in production`,
    };
  }
  if (check.status === LicenseStatus.EXPIRED) {
    return {
      status: 'expired',
      detail: 'license expired — renew to keep using enterprise features',
    };
  }
  return { status: 'invalid', detail: `license key rejected (${check.status})` };
}

/**
 * Gate an enterprise feature using env-resolved activation. Enforcement is ON only when the issuer
 * public key is configured (i.e. a real release); without it (dev/repo) features run free in eval mode.
 */
export function assertEnterpriseFromEnv(
  feature: string,
  now: number,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const publicKey = loadPublicKey(env[LICENSE_PUBLIC_KEY_ENV]);
  const key = env[LICENSE_KEY_ENV];
  assertEnterprise(feature, {
    requireLicense: publicKey !== undefined,
    now: () => now,
    ...(key !== undefined ? { key } : {}),
    ...(publicKey !== undefined ? { publicKey } : {}),
  });
}
