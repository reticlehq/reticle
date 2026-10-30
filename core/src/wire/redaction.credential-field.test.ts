import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_FIELD_WORDS,
  defaultIsSensitiveKey,
  isCredentialFieldName,
} from './redaction.js';

/**
 * A recorded fill is redacted when its field name says it holds a credential.
 *
 * Field report: a password field with the accessible name "Пароль" was saved in clear in a flow
 * file, because the name rule was English only. An SDK before 3.8.0 sends no secret mark, so the
 * name is the only signal the server has.
 */
describe('the credential field-name rule', () => {
  it.each(CREDENTIAL_FIELD_WORDS)('matches "%s" as a field name', (word) => {
    expect(isCredentialFieldName(word)).toBe(true);
    expect(isCredentialFieldName(`  ${word.toUpperCase()}: `)).toBe(true);
  });

  it.each([
    'Пароль',
    'Введите пароль',
    'Mot de passe',
    'Mot de passe actuel',
    'Contraseña',
    'Passwort wiederholen',
    'Hasło',
    'Şifre',
    'Κωδικός',
    'パスワードを入力',
    '비밀번호를 입력하세요',
    'รหัสผ่านของคุณ',
    'PIN',
    'Код подтверждения',
    'login_passwort',
  ])('matches the label "%s"', (label) => {
    expect(isCredentialFieldName(label)).toBe(true);
  });

  it('keeps the English rule', () => {
    expect(isCredentialFieldName('auth-password')).toBe(true);
    expect(isCredentialFieldName('apiKey')).toBe(true);
  });

  it.each([
    'Email',
    'Электронная почта',
    'Парольный менеджер',
    'Pinterest',
    'Spinner',
    'Kodak',
    'Passworth',
    'Nom',
    'Search',
  ])('does not match "%s"', (label) => {
    expect(isCredentialFieldName(label)).toBe(false);
  });

  it('is not a part of the network key rule', () => {
    expect(defaultIsSensitiveKey('Пароль')).toBe(false);
  });
});
