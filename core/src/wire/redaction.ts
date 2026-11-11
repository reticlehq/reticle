// Copyright (c) 2026 Reticle Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/**
 * Redaction rules for sensitive keys and values flowing through Reticle wire protocols.
 *
 * Wire records (network transactions, console logs, environment payloads, state snapshots) pass
 * through these filters before being stored in the journal, emitted to agents, or serialized into
 * artifacts. Redaction is destructive and irreversible by design: once a field is redacted to the
 * sentinel token, the plaintext cannot be recovered from downstream traces.
 *
 * Keys are checked against {@link SENSITIVE_KEY} case-insensitively. Values can also be checked
 * independently via entropy/pattern detectors (e.g. JWTs, bearer tokens, private keys) when the
 * key name itself is ambiguous or absent.
 */

import { URL_RAW } from './net.js';

/** Sentinel replacement text inserted in place of sensitive plaintext values. */
export const REDACTED_VALUE = '[REDACTED]';

// Case-insensitive regex matching field/key names whose values must never be retained in plaintext.
// Note on card fields: the rule matches `card` with boundaries because real-world payment telemetry
// reaches the agent as `{"planId":"team","card":"4111111111111111"}` — `credit_card` and
// `card_number` are not the only spellings, and `card` is what Stripe's own object calls it. The
// anchors keep `discard`, `cardinality` and `panel` visible.
// Bank-transfer identifiers mirror `PAYMENT_FIELD_WORDS` in `core/src/verdict/security.ts`, which
// already treats `iban`, `account number`, `routing number` and `sort code` as payment-sensitive.
// Without them a bank-transfer or payout POST leaks `{"iban":"…","accountNumber":"…","routingNumber":"…","sortCode":"…"}`
// into the journal and the agent transcript — the same class of leak as the unredacted `card` field above.
// `iban` is unanchored because few ordinary English words contain it and payout APIs frequently
// use prefixed shapes (`customerIban`, `beneficiaryIban`, `payeeIban`, `creditorIban`, `debtorIban`,
// `ibanNumber`). Account numbers cover `acct` and `account` with `numbers?`, `num`, `no` or `last4`.
// Bare `account`, `routing`, `sort` and `code` stay visible: `accountId`, `accountType`,
// `accountName`, `routingPath`, `sortOrder` and `sortBy` are ordinary app data an agent needs.
const SENSITIVE_KEY =
  /password|passwd|passcode|pass[-_]?phrase|(?:otp|totp|mfa|recovery|backup)[-_]?codes?|(?:^|[-_])(?:otp|totp)(?=$|[-_])|secret|(?:(?:access|refresh|auth|bearer|api|id|session|csrf|client)[-_]?tokens?|(?:^|[-_])tokens?(?=$|[-_]))|session[-_]?id|(?:^|[-_])(?:sid|pwd|jwt)(?=$|[-_])|authorization|(?:^|[-_])(?:set[-_])?cookie(?=$|[-_])|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|credit[-_]?card|card[-_]?(?:number|num|no|pan)(?=$|[-_])|(?:^|[-_])(?:card|pan)(?=$|[-_])|iban|(?:acct|account)[-_]?(?:numbers?|num|no)(?:[-_]?last4)?(?=$|[-_])|routing[-_]?number(?=$|[-_])|sort[-_]?code(?=$|[-_])|cvv|cvc|ssn|(?:^|[-_])(?:signature|sig)$|(?:^|[-_])credential$|x-(?:amz|goog)-(?:signature|credential|security-token)$/i;

/**
 * The built-in rule, always available and never configurable.
 *
 * Checks whether a key/field name is inherently sensitive according to the built-in regex.
 *
 * @param key - The field or parameter name to evaluate.
 * @returns `true` if the key matches known sensitive naming conventions.
 */
export function defaultIsSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/**
 * Checks whether an environment variable name is inherently sensitive.
 *
 * Extends the default key check with environment-specific conventions (e.g. uppercase tokens,
 * common prefix/suffix patterns like `_TOKEN`, `_SECRET`, `_KEY`).
 *
 * @param envVarName - The environment variable name to evaluate.
 * @returns `true` if the environment variable should be redacted.
 */
export function defaultIsSensitiveEnv(envVarName: string): boolean {
  return SENSITIVE_KEY.test(envVarName);
}

/**
 * Predicate type for custom key sensitivity checks.
 */
export type IsSensitiveKey = (key: string) => boolean;

/**
 * Predicate type for custom value sensitivity checks.
 */
export type IsSensitiveValue = (value: unknown) => boolean;

/**
 * Options for configuring wire-level redaction behavior.
 */
export interface RedactionOptions {
  /** Optional custom predicate to identify sensitive keys. */
  readonly isSensitiveKey?: IsSensitiveKey | undefined;
  /** Optional custom predicate to identify sensitive values regardless of key name. */
  readonly isSensitiveValue?: IsSensitiveValue | undefined;
}

/**
 * Redacts sensitive values in an object or array shallowly or deeply according to key rules.
 *
 * @param value - The data structure to redact.
 * @param options - Configuration options controlling key and value sensitivity checks.
 * @returns A sanitized clone of the data with sensitive values replaced by {@link REDACTED_VALUE}.
 */
export function redactSensitiveData<T>(value: T, options?: RedactionOptions | undefined): T {
  const isKey = options?.isSensitiveKey ?? defaultIsSensitiveKey;
  const isVal = options?.isSensitiveValue;

  return redactInternal(value, isKey, isVal);
}

function redactInternal<T>(
  val: T,
  isKey: IsSensitiveKey,
  isVal: IsSensitiveValue | undefined,
): T {
  if (val === null || val === undefined) {
    return val;
  }

  if (typeof val === 'string') {
    if (isVal?.(val)) {
      return REDACTED_VALUE as unknown as T;
    }
    return val;
  }

  if (Array.isArray(val)) {
    return val.map((item) => redactInternal(item, isKey, isVal)) as unknown as T;
  }

  if (typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (isKey(k)) {
        out[k] = REDACTED_VALUE;
      } else {
        out[k] = redactInternal(v, isKey, isVal);
      }
    }
    return out as unknown as T;
  }

  return val;
}
