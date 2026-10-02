import { describe, expect, it } from 'vitest';
import { collectEnv, DEFAULT_SETUP_OPTIONS, parseEnvAssignment } from './setup-options.js';

describe('the environment an agent supplies', () => {
  it('reads a plain assignment', () => {
    expect(parseEnvAssignment('VITE_API=http://localhost:8000')).toEqual({
      key: 'VITE_API',
      value: 'http://localhost:8000',
    });
  });

  // A token, a connection string, a base64 value: everything after the FIRST `=` is the value.
  it('keeps every later equals sign in the value', () => {
    expect(parseEnvAssignment('TOKEN=a=b=c')?.value).toBe('a=b=c');
  });

  it('accepts an empty value, which is a real way to unset a default', () => {
    expect(parseEnvAssignment('DEBUG=')).toEqual({ key: 'DEBUG', value: '' });
  });

  // Dropped rather than guessed at: an agent that mistypes should see its variable missing, not see
  // setup invent one.
  it('refuses what cannot be a variable name', () => {
    expect(parseEnvAssignment('no-equals-sign')).toBeNull();
    expect(parseEnvAssignment('=leading')).toBeNull();
    expect(parseEnvAssignment('has space=x')).toBeNull();
    expect(parseEnvAssignment('1STARTS_WITH_DIGIT=x')).toBeNull();
  });

  it('folds repeated flags into one map and ignores the malformed', () => {
    expect(collectEnv(['A=1', 'nonsense', 'B=2'])).toEqual({ A: '1', B: '2' });
  });

  it('lets a later assignment win, so a caller can override its own default', () => {
    expect(collectEnv(['A=1', 'A=2'])).toEqual({ A: '2' });
  });
});

describe('defaults', () => {
  // The two ports are different things, and conflating them is a documented setup failure.
  it('defaults the BRIDGE port, not a dev server port', () => {
    expect(DEFAULT_SETUP_OPTIONS.bridgePort).toBe(4400);
  });

  // Either of these off by default would make onboarding quietly do less than it says.
  // `drive` and `escalateWeakFlow` used to be asserted here too. Onboarding stopped driving in
  // 7e698fea, which left both fields with no reader anywhere -- so the assertions were pinning a
  // constant against itself and would have gone on passing after the behaviour was deleted.
  it('opens a browser and registers agents by default', () => {
    expect(DEFAULT_SETUP_OPTIONS.openBrowser).toBe(true);
    expect(DEFAULT_SETUP_OPTIONS.registerAgents).toBe(true);
  });

  it('does not stop after writing files unless asked', () => {
    expect(DEFAULT_SETUP_OPTIONS.filesOnly).toBe(false);
  });

  it('carries no agent judgement by default, because only the caller can supply them', () => {
    // `flow` was asserted here too, until onboarding stopped driving in 7e698fea retired `--flow`
    // and left the field with no reader and no setter.
    expect(DEFAULT_SETUP_OPTIONS.app).toBeUndefined();
    expect(DEFAULT_SETUP_OPTIONS.env).toBeUndefined();
  });
});
