import { describe, expect, it } from 'vitest';
import { personaCredentials } from './persona-credentials.js';
import { secretNames, withSecrets } from './server-driver.js';

/*
 * A persona that gave its email and password was driven with `harness@reticle.dev` and a 401, and
 * the password was stored in the synced run's text.
 */
describe('the credentials a persona names', () => {
  const said = 'Ana signs in as ana@acme.test with password: hunter2 and opens "Just me"';

  it('fills the sign-in fields from them, and never sends the password', () => {
    const { persona, secrets } = personaCredentials(said);
    expect(persona).toBe(
      'Ana signs in as ana@acme.test with password: [redacted] and opens "Just me"',
    );
    const env = { RETICLE_SECRET_PASSWORD: 'from-env', ...secrets };
    expect(secretNames(env)).toEqual(
      expect.arrayContaining(['EMAIL', 'EMAIL_ADDRESS', 'PASSWORD']),
    );
    expect(withSecrets({ args: { value: 'reticle-secret:Email address' } }, env)).toEqual({
      args: { value: 'ana@acme.test' },
    });
    expect(withSecrets({ value: 'reticle-secret:Password' }, env)).toEqual({ value: 'hunter2' });
  });

  it('reads a quoted password, and leaves a persona without one alone', () => {
    expect(personaCredentials('password "s3cret word"').secrets['RETICLE_SECRET_PASSWORD']).toBe(
      's3cret word',
    );
    expect(personaCredentials('reset the password from the menu')).toEqual({
      persona: 'reset the password from the menu',
      secrets: {},
    });
  });

  // Lena's persona put its password in parentheses; the ")" was typed with it, and every sign-in was a 401.
  it('stops an unquoted password at a closing bracket or a sentence end', () => {
    const lena = personaCredentials(
      'Lena (email lena@example.com, password: DriveP17-pass-2026!): open Runs',
    );
    expect(lena.secrets['RETICLE_SECRET_PASSWORD']).toBe('DriveP17-pass-2026!');
    expect(lena.persona).toBe('Lena (email lena@example.com, password: [redacted]): open Runs');
    expect(
      personaCredentials('Sign in, password is hunter2. Then open Runs').secrets[
        'RETICLE_SECRET_PASSWORD'
      ],
    ).toBe('hunter2');
  });

  /*
   * Persona drive: Nina's journey named her and her password ("Nina, … password Nina-pass-12345!").
   * The Harness typed "reticle harness" as her first name and never typed the password: an unquoted
   * value after the bare word was not read, and nothing offered her name for a name field.
   */
  it('reads a password written after the bare word, and redacts it', () => {
    const nina = personaCredentials(
      'Nina, new here: sign up with password Nina-pass-12345! and open Runs',
    );
    expect(nina.secrets['RETICLE_SECRET_PASSWORD']).toBe('Nina-pass-12345!');
    expect(nina.secrets['RETICLE_SECRET_CREATE_A_PASSWORD']).toBe('Nina-pass-12345!');
    expect(nina.persona).not.toContain('Nina-pass-12345!');
  });

  it("offers the persona's own name for a name field, never one it made up", () => {
    const nina = personaCredentials('Nina Patel, who found the dashboard: sign up');
    expect(nina.secrets['RETICLE_SECRET_FIRST_NAME']).toBe('Nina');
    expect(nina.secrets['RETICLE_SECRET_LAST_NAME']).toBe('Patel');
    expect(nina.secrets['RETICLE_SECRET_FULL_NAME']).toBe('Nina Patel');
    expect(personaCredentials('an admin who checks the billing page').secrets).toEqual({});
  });
});
