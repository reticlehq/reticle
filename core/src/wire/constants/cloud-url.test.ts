import { describe, expect, it } from 'vitest';
import { cloudUrlFrom, ReticleEnv } from '../../index.js';

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
