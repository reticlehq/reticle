import { describe, expect, it } from 'vitest';
import { defaultIsSensitiveKey } from './redaction.js';

describe('the default key rule covers bank-transfer identifiers alongside card fields', () => {
  const REDACTED: readonly string[] = [
    'iban',
    'IBAN',
    'customerIban',
    'beneficiaryIban',
    'payeeIban',
    'ibanNumber',
    'creditorIban',
    'debtorIban',
    'accountHolderIban',
    'user_iban',
    'user-iban',
    'accountNumber',
    'account_number',
    'account-number',
    'accountNo',
    'accountNum',
    'accountNumbers',
    'accountNumberLast4',
    'account_number_last4',
    'account-number-last4',
    'acctNumber',
    'acct_number',
    'acctNo',
    'acctNumbers',
    'acctNumberLast4',
    'routingNumber',
    'routing_number',
    'routing-number',
    'sortCode',
    'sort_code',
    'sort-code',
  ];

  for (const key of REDACTED) {
    it(`redacts ${key}`, () => {
      expect(defaultIsSensitiveKey(key)).toBe(true);
    });
  }
});

describe('it leaves ordinary application keys visible', () => {
  const VISIBLE: readonly string[] = [
    'account',
    'accountId',
    'accountType',
    'accountName',
    'routingPath',
    'routing',
    'sort',
    'sortOrder',
    'sortBy',
    'code',
    'bankName',
    'acct',
    'acctId',
  ];

  for (const key of VISIBLE) {
    it(`leaves ${key} visible`, () => {
      expect(defaultIsSensitiveKey(key)).toBe(false);
    });
  }
});
