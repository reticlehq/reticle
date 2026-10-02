import { describe, expect, it } from 'vitest';
import { apiKeyFrom, ReticleEnv } from '../../index.js';

/**
 * One key, two names, and the old one may not be dropped.
 *
 * The console printed `RETICLE_CLOUD_KEY` to every user who ever connected a project, so it is
 * exported in shells and CI configs nobody here can see or edit. A rename that stops reading it
 * does not look like a rename to those people — it looks like the product losing their credentials.
 */
describe('resolving the platform API key', () => {
  it('reads the current name', () => {
    expect(apiKeyFrom({ RETICLE_API_KEY: 'rk_live_new' })).toBe('rk_live_new');
  });

  it('still reads the name it had before, because it is exported in configs we cannot edit', () => {
    expect(apiKeyFrom({ RETICLE_CLOUD_KEY: 'rk_live_old' })).toBe('rk_live_old');
  });

  /** So somebody migrating can set the new one and confirm it works before removing the old. */
  it('prefers the current name when both are set', () => {
    expect(apiKeyFrom({ RETICLE_API_KEY: 'new', RETICLE_CLOUD_KEY: 'old' })).toBe('new');
  });

  it('treats an empty value as absent, under either name', () => {
    expect(apiKeyFrom({ RETICLE_API_KEY: '' })).toBeUndefined();
    expect(apiKeyFrom({ RETICLE_API_KEY: '', RETICLE_CLOUD_KEY: 'fallback' })).toBe('fallback');
  });

  it('answers nothing when neither is set', () => {
    expect(apiKeyFrom({})).toBeUndefined();
  });

  it('names both variables, so a caller never spells one inline', () => {
    expect(ReticleEnv.API_KEY).toBe('RETICLE_API_KEY');
    expect(ReticleEnv.CLOUD_KEY).toBe('RETICLE_CLOUD_KEY');
  });
});
