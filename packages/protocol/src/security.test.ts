import { describe, expect, it } from 'vitest';
import { isDangerousActionText, isLoopbackHostname } from './security.js';

describe('isLoopbackHostname', () => {
  it('accepts literal IPv4, IPv6, and localhost loopback hosts', () => {
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('127.255.255.254')).toBe(true);
    expect(isLoopbackHostname('[::1]')).toBe(true);
  });

  it('rejects DNS lookalikes and invalid IPv4 literals', () => {
    expect(isLoopbackHostname('127.evil.example')).toBe(false);
    expect(isLoopbackHostname('localhost.example')).toBe(false);
    expect(isLoopbackHostname('127.0.0.999')).toBe(false);
  });
});

describe('isDangerousActionText', () => {
  it('matches destructive labels and separator-delimited tool names', () => {
    expect(isDangerousActionText('Delete account')).toBe(true);
    expect(isDangerousActionText('delete_account')).toBe(true);
    expect(isDangerousActionText('transfer-funds')).toBe(true);
  });

  it('does not block ordinary read-only controls', () => {
    expect(isDangerousActionText('Search records')).toBe(false);
    expect(isDangerousActionText('Open settings')).toBe(false);
  });
});
