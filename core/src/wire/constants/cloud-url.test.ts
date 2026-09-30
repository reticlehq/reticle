import { describe, expect, it } from 'vitest';
import {
  cloudUrlFrom,
  DEFAULT_PLATFORM_URL,
  platformCredentialFrom,
  platformUrlFrom,
  ReticleEnv,
} from '../../index.js';

/** `RETICLE_URL` is the short name people reach for; `RETICLE_CLOUD_URL` stays the canonical one. */
describe('resolving the platform URL', () => {
  it('reads RETICLE_CLOUD_URL', () => {
    expect(cloudUrlFrom({ RETICLE_CLOUD_URL: 'https://a.test' })).toBe('https://a.test');
  });

  it('accepts RETICLE_URL on its own', () => {
    expect(cloudUrlFrom({ RETICLE_URL: 'https://b.test' })).toBe('https://b.test');
  });

  it('prefers RETICLE_CLOUD_URL when both are set', () => {
    expect(
      cloudUrlFrom({ RETICLE_CLOUD_URL: 'https://a.test', RETICLE_URL: 'https://b.test' }),
    ).toBe('https://a.test');
  });

  it('treats an empty value as absent', () => {
    expect(cloudUrlFrom({ RETICLE_CLOUD_URL: '', RETICLE_URL: 'https://b.test' })).toBe(
      'https://b.test',
    );
    expect(cloudUrlFrom({})).toBeUndefined();
  });

  it('names both variables', () => {
    expect(ReticleEnv.CLOUD_URL).toBe('RETICLE_CLOUD_URL');
    expect(ReticleEnv.URL).toBe('RETICLE_URL');
  });
});

/**
 * The key on its own is enough. The Connect page tells a CI user that RETICLE_API_KEY is the only
 * thing to set and that the hosted service is the default, so a resolver that also demanded a URL
 * made that instruction false and left every CI run syncing nothing.
 */
describe('the platform credential from the environment', () => {
  it('pairs a lone key with the hosted service', () => {
    expect(platformCredentialFrom({ RETICLE_API_KEY: 'rk_1' })).toEqual({
      url: DEFAULT_PLATFORM_URL,
      apiKey: 'rk_1',
    });
  });

  it('honours the key under its previous name', () => {
    expect(platformCredentialFrom({ RETICLE_CLOUD_KEY: 'rk_old' })?.apiKey).toBe('rk_old');
  });

  it('lets an explicit URL win over the default, without its trailing slash', () => {
    expect(
      platformCredentialFrom({ RETICLE_API_KEY: 'rk_1', RETICLE_URL: 'https://self.test/' })?.url,
    ).toBe('https://self.test');
  });

  it('is absent without a key, whatever the URL says', () => {
    expect(platformCredentialFrom({ RETICLE_CLOUD_URL: 'https://a.test' })).toBeUndefined();
  });

  it('defaults the URL alone to the hosted service', () => {
    expect(platformUrlFrom({})).toBe(DEFAULT_PLATFORM_URL);
    expect(DEFAULT_PLATFORM_URL).toBe('https://app.reticle.sh');
  });
});
