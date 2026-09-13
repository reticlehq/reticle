import { describe, expect, it } from 'vitest';
import { isSensitiveKey } from './redaction.js';

describe('isSensitiveKey — presigned URL credential parameters', () => {
  it('matches AWS presigned URL parameters', () => {
    for (const k of [
      'X-Amz-Credential',
      'X-Amz-Signature',
      'X-Amz-Security-Token',
      'x-amz-credential',
      'x-amz-signature',
      'x-amz-security-token',
    ]) {
      expect(isSensitiveKey(k), `expected "${k}" to be sensitive`).toBe(true);
    }
  });

  it('matches GCS presigned URL parameters', () => {
    for (const k of ['X-Goog-Signature', 'X-Goog-Credential', 'x-goog-signature']) {
      expect(isSensitiveKey(k), `expected "${k}" to be sensitive`).toBe(true);
    }
  });

  it('matches bare credential/signature keys with word boundaries', () => {
    for (const k of ['signature', 'Signature', 'sig', 'credential', 'Credential']) {
      expect(isSensitiveKey(k), `expected "${k}" to be sensitive`).toBe(true);
    }
  });

  it('matches hyphenated/underscored credential keys at boundaries', () => {
    for (const k of ['access-signature', 'request_signature', 'auth-sig', 'user_credential']) {
      expect(isSensitiveKey(k), `expected "${k}" to be sensitive`).toBe(true);
    }
  });

  it('does NOT match keys where signature/sig/credential are embedded substrings', () => {
    for (const k of [
      'signatureVersion',
      'signatureMethod',
      'sig_algo',
      'design-signature-v2',
      'credentialScope',
      'insignificant',
    ]) {
      expect(isSensitiveKey(k), `expected "${k}" to NOT be sensitive`).toBe(false);
    }
  });

  it('does NOT match AWS/GCS non-secret presigned URL parameters', () => {
    for (const k of [
      'X-Amz-Algorithm',
      'X-Amz-Date',
      'X-Amz-Expires',
      'X-Amz-SignedHeaders',
      'X-Amz-SignatureVersion',
      'X-Amz-CredentialScope',
      'X-Goog-Algorithm',
      'X-Goog-Date',
      'X-Goog-Expires',
      'X-Goog-SignatureVersion',
    ]) {
      expect(isSensitiveKey(k), `expected "${k}" to NOT be sensitive`).toBe(false);
    }
  });
});
