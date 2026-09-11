import { describe, expect, it } from 'vitest';
import { defaultIsSensitiveKey } from './redaction.js';

/**
 * The key rule is the half of redaction that fires on a field's NAME, and it already covers three
 * spellings of the same secret: `password`, `passwd`, `passcode`. It did not cover the fourth.
 *
 * A passphrase is the same class of thing and is asked for by that name: an SSH key passphrase, a
 * wallet or encrypted-backup passphrase, a keystore passphrase. There is no benign field called
 * `passphrase`, so this is a gap rather than a judgement call.
 *
 * One-time codes are the second family. They expire, which is why they are easy to wave away, but
 * the window in which one is useful is exactly the window in which a drive is running, and the
 * journal is written to disk and read back later.
 */
describe('the key rule covers the credential families it already half-covers', () => {
  const REDACTED: readonly string[] = [
    // The sibling of the three spellings already covered.
    'passphrase',
    'passPhrase',
    'pass_phrase',
    'pass-phrase',
    'wallet_passphrase',
    'sshKeyPassphrase',
    // One-time codes, in the spellings an app actually uses.
    'otp',
    'user_otp',
    'otp_code',
    'otpCode',
    'totp',
    'totpSecret',
    'mfa_code',
    'mfaCode',
    'recovery_code',
    'recoveryCode',
    'backup_codes',
    'backupCodes',
  ];

  for (const key of REDACTED) {
    it(`redacts ${key}`, () => {
      expect(defaultIsSensitiveKey(key)).toBe(true);
    });
  }
});

/**
 * The other half of the contract. A key rule that fires on ordinary app data is worse than a narrow
 * one: it hides values an agent needs in order to reach a verdict, and the file's own history is a
 * list of false positives that had to be walked back (`designToken`, `cookieConsent`).
 */
describe('it leaves ordinary application keys visible', () => {
  const VISIBLE: readonly string[] = [
    'phrase',
    'searchPhrase',
    'phraseCount',
    'code',
    'codeOwner',
    'statusCode',
    'postcode',
    'zipCode',
    'countryCode',
    'currencyCode',
    'errorCode',
    'couponCode',
    'languageCode',
    'backup',
    'backupEnabled',
    'recovery',
    'recoveryUrl',
    'optIn',
    'optionLabel',
    'adoption',
    'designToken',
    'cookieConsent',
    'username',
    'email',
  ];

  for (const key of VISIBLE) {
    it(`leaves ${key} visible`, () => {
      expect(defaultIsSensitiveKey(key)).toBe(false);
    });
  }
});
