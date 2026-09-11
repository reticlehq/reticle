import { describe, expect, it } from 'vitest';
import { InstallSource } from '@reticlehq/core/telemetry';
import { INSTALL_SOURCE_ENV, resolveInstallSource } from './install-source.js';

/**
 * The whole value of this field is that it never guesses. A wrong attribution and a missing one look
 * identical on a dashboard, and only one of them can be corrected later.
 */
describe('install source', () => {
  it('reports the marker a channel set on itself', () => {
    expect(resolveInstallSource({ [INSTALL_SOURCE_ENV]: 'plugin' })).toBe(InstallSource.PLUGIN);
  });

  it('accepts every published channel name, so no route is silently unattributable', () => {
    for (const source of Object.values(InstallSource)) {
      expect(resolveInstallSource({ [INSTALL_SOURCE_ENV]: source })).toBe(source);
    }
  });

  it('tolerates the casing and padding a shell snippet picks up', () => {
    expect(resolveInstallSource({ [INSTALL_SOURCE_ENV]: ' Skill_File ' })).toBe(
      InstallSource.SKILL_FILE,
    );
  });

  it('reports unknown when nothing set a marker', () => {
    expect(resolveInstallSource({})).toBe(InstallSource.UNKNOWN);
  });

  it('reports unknown rather than forwarding a name it does not recognise', () => {
    // An echo would put whatever somebody exported — a path, a URL, a campaign string — on the wire.
    expect(resolveInstallSource({ [INSTALL_SOURCE_ENV]: 'https://example.com/promo' })).toBe(
      InstallSource.UNKNOWN,
    );
  });
});
