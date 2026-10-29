/**
 * License-key verification for `reticle license` and the telemetry `licenseStatus` field.
 *
 * Offline, with no phone-home: a key is a signed payload that Reticle issues with its private key.
 * This file verifies it against the issuer's PUBLIC key with Ed25519. Nothing in this package is
 * gated on a key. The clock is injected (rule 7).
 */

import { createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { LicenseActivation } from '@reticlehq/core/telemetry';

/** Outcome of verifying a license key. */
export const LicenseStatus = {
  VALID: 'valid',
  MISSING: 'missing',
  MALFORMED: 'malformed',
  BAD_SIGNATURE: 'bad-signature',
  EXPIRED: 'expired',
} as const;
export type LicenseStatus = (typeof LicenseStatus)[keyof typeof LicenseStatus];

/**
 * The signed claims inside a key. `exp` is epoch ms; `features` (optional) scopes the features that
 * the key covers.
 *
 * `lid` is the stable licence id and the only safe identity: `org` is a display name a human typed at
 * signing time, so two organisations with the same name collapse into one and a rename splits one into
 * two. Every key carries one, minted by the issuer (`scripts/issue-license.mjs`), and it is required
 * rather than optional because an optional id goes missing on exactly the keys that later need
 * identifying.
 */
const LicensePayloadSchema = z.object({
  lid: z.string().min(1),
  org: z.string(),
  plan: z.string(),
  exp: z.number(),
  features: z.array(z.string()).optional(),
});
export type LicensePayload = z.infer<typeof LicensePayloadSchema>;

type LicenseCheck =
  | { status: typeof LicenseStatus.VALID; payload: LicensePayload }
  /**
   * EXPIRED carries the payload; the other failures cannot. The line is the SIGNATURE, not the
   * clock: an expired key was genuinely issued by us and its claims are exactly as trustworthy as
   * they were yesterday, so the licence id is safe to use. A malformed or wrongly-signed key has no
   * verified claims at all, and naming a customer from one would mean trusting whatever was pasted.
   */
  | { status: typeof LicenseStatus.EXPIRED; payload: LicensePayload }
  | {
      status: Exclude<LicenseStatus, typeof LicenseStatus.VALID | typeof LicenseStatus.EXPIRED>;
    };

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
  if (key === undefined || 0 === key.length) {
    return { status: LicenseStatus.MISSING };
  }
  const parts = key.split(KEY_SEP);
  if (
    parts.length !== 2 ||
    parts[0] === undefined ||
    parts[1] === undefined ||
    0 === parts[0].length
  ) {
    return { status: LicenseStatus.MALFORMED };
  }

  let json: string;
  let payload: LicensePayload;
  try {
    json = Buffer.from(parts[0], 'base64url').toString('utf8');
    const parsed = LicensePayloadSchema.safeParse(JSON.parse(json));
    if (!parsed.success) {
      return { status: LicenseStatus.MALFORMED };
    }
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
  if (!signatureOk) {
    return { status: LicenseStatus.BAD_SIGNATURE };
  }
  if (payload.exp <= now) {
    return { status: LicenseStatus.EXPIRED, payload };
  }
  return { status: LicenseStatus.VALID, payload };
}

/**
 * Where to get a key. A named constant because `reticle license` prints it on every branch, and a
 * contact address that drifts is a support request that reaches nobody.
 */
export const LICENSE_CONTACT = 'hey@reticle.sh';

/** Env names that carry the activation: the operator's key, and the issuer public key baked at release. */
export const LICENSE_KEY_ENV = 'RETICLE_LICENSE_KEY';
export const LICENSE_PUBLIC_KEY_ENV = 'RETICLE_LICENSE_PUBLIC_KEY';

/**
 * Issuer public key COMPILED INTO the build. Empty in the source tree; the release pipeline replaces
 * this literal with the real spki PEM. The baked key takes precedence over RETICLE_LICENSE_PUBLIC_KEY,
 * so an operator cannot swap in a key of their own. The public key is safe to ship openly: it can
 * only verify licenses, never mint them (that needs the private key).
 */
const BAKED_ISSUER_PUBLIC_KEY_PEM = '';

/**
 * Resolve the issuer public-key PEM: the baked-in release key wins, so the environment cannot
 * replace it. Only when nothing is baked (dev/repo) does the env var apply — that
 * env path is the test/self-eval escape hatch, not the production switch.
 */
function resolveIssuerPublicKeyPem(
  env: NodeJS.ProcessEnv,
  baked: string = BAKED_ISSUER_PUBLIC_KEY_PEM,
): string | undefined {
  if (baked.length > 0) {
    return baked;
  }
  const envPem = env[LICENSE_PUBLIC_KEY_ENV];
  return envPem !== undefined && envPem.length > 0 ? envPem : undefined;
}

/** The human-facing state of license activation on this machine (what `reticle license` shows). */
interface LicenseReport {
  /**
   * Typed against core's closed list rather than re-listing the strings here: this status is reported
   * on every telemetry event, so a member added in one place and not the other is a silently
   * miscounted column (telemetry contract, rule 4).
   */
  status: LicenseActivation;
  /** The stable license id — what usage is attributed to. Present only when `status` is `active`. */
  licenseId?: string;
  contact: string;
  org?: string;
  plan?: string;
  expiresAt?: number;
  features?: string[];
  detail: string;
}

function loadPublicKey(pem: string | undefined): KeyObject | undefined {
  if (pem === undefined || 0 === pem.length) {
    return undefined;
  }
  try {
    return createPublicKey(pem);
  } catch {
    return undefined;
  }
}

/**
 * Resolve activation entirely from the environment — the install mechanism: the release bakes the
 * issuer public key, the operator sets RETICLE_LICENSE_KEY. No public key configured ⇒ evaluation mode.
 * Offline, no phone-home.
 */
export function describeLicense(
  now: number,
  env: NodeJS.ProcessEnv = process.env,
  baked: string = BAKED_ISSUER_PUBLIC_KEY_PEM,
): LicenseReport {
  const pem = resolveIssuerPublicKeyPem(env, baked);
  if (pem === undefined || 0 === pem.length) {
    // In a production runtime this is NOT a benign eval session: it is a mis-built release. Say so.
    return isProductionEnv(env)
      ? {
          contact: LICENSE_CONTACT,
          status: LicenseActivation.INVALID,
          detail:
            'MISCONFIGURED — running in production with no issuer key baked (rebuild with BAKED_ISSUER_PUBLIC_KEY_PEM stamped in)',
        }
      : {
          contact: LICENSE_CONTACT,
          status: LicenseActivation.EVAL,
          detail: 'evaluation mode (no issuer key configured)',
        };
  }
  const publicKey = loadPublicKey(pem);
  if (publicKey === undefined) {
    return {
      contact: LICENSE_CONTACT,
      status: LicenseActivation.INVALID,
      detail: `${LICENSE_PUBLIC_KEY_ENV} is not a valid public key`,
    };
  }

  const check = verifyLicenseKey(env[LICENSE_KEY_ENV], publicKey, now);
  if (check.status === LicenseStatus.VALID) {
    const { lid, org, plan, exp, features } = check.payload;
    return {
      contact: LICENSE_CONTACT,
      status: LicenseActivation.ACTIVE,
      licenseId: lid,
      org,
      plan,
      expiresAt: exp,
      ...(features !== undefined ? { features } : {}),
      detail: `licensed to ${org} (${plan}), expires ${new Date(exp).toISOString()}`,
    };
  }
  if (check.status === LicenseStatus.MISSING) {
    return {
      contact: LICENSE_CONTACT,
      status: LicenseActivation.MISSING,
      detail: `set ${LICENSE_KEY_ENV} to activate a license. Request a key from ${LICENSE_CONTACT}`,
    };
  }
  if (check.status === LicenseStatus.EXPIRED) {
    // The id rides an expired key so the lapse can be identified; without it an expiry is
    // indistinguishable from any other.
    return {
      contact: LICENSE_CONTACT,
      status: LicenseActivation.EXPIRED,
      licenseId: check.payload.lid,
      org: check.payload.org,
      expiresAt: check.payload.exp,
      detail: `license expired. Renew with ${LICENSE_CONTACT}`,
    };
  }
  return {
    contact: LICENSE_CONTACT,
    status: LicenseActivation.INVALID,
    detail: `license key rejected (${check.status}). ${LICENSE_CONTACT} can re-issue it`,
  };
}

/** True in a production runtime (NODE_ENV=production), where a missing issuer key is a mis-built
 *  release, not an eval session. */
function isProductionEnv(env: NodeJS.ProcessEnv): boolean {
  return 'production' === env['NODE_ENV'];
}
