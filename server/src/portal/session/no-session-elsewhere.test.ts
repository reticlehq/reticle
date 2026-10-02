/**
 * "There is no `.reticle.json`" was a claim about ONE directory, reported as a claim about a project.
 *
 * The daemon's working directory is whatever the editor that launched it happened to be in — the
 * user's home, in at least one popular client — while the config sits under the app package. The
 * message then told a reader with a wired, working app to go and install Reticle.
 *
 * Two things fix it, and both are about honesty rather than search: name the configs that WERE
 * found elsewhere, and when none was found say where we looked.
 */

import { describe, expect, it } from 'vitest';
import { diagnoseNoSession } from './no-session-diagnosis.js';

describe('a config found somewhere else is named, not ignored', () => {
  it('names the directory of a config found outside the daemon cwd', () => {
    const why = diagnoseNoSession({
      everConnected: false,
      initialized: false,
      listening: [3000],
      port: 4400,
      directory: '/Users/someone',
      configsElsewhere: [{ directory: '/repo/apps/web', projectId: 'web-1' }],
    });
    expect(why).toContain('/repo/apps/web');
    // The whole point: the project is wired, so this is a SCOPE problem, not an install problem.
    expect(why).toMatch(/scope|directory|restart the daemon|cd /i);
  });

  it('names ALL of them rather than silently choosing one', () => {
    const why = diagnoseNoSession({
      everConnected: false,
      initialized: false,
      listening: [3000],
      port: 4400,
      configsElsewhere: [
        { directory: '/repo/apps/web' },
        { directory: '/repo/apps/admin', projectId: 'admin-1' },
      ],
    });
    expect(why).toContain('/repo/apps/web');
    expect(why).toContain('/repo/apps/admin');
  });

  it('does not tell a project whose config was found elsewhere to run init', () => {
    const why = diagnoseNoSession({
      everConnected: false,
      initialized: false,
      listening: [3000],
      port: 4400,
      configsElsewhere: [{ directory: '/repo/apps/web', projectId: 'web-1' }],
    });
    expect(why).not.toContain('reticle init');
  });

  it('says where it looked when it found nothing anywhere', () => {
    const why = diagnoseNoSession({
      everConnected: false,
      initialized: false,
      listening: [3000],
      port: 4400,
      directory: '/Users/someone',
      searchedDirectories: ['/Users/someone', '/Users', '/repo/apps/web'],
    });
    expect(why).toContain('/repo/apps/web');
    expect(why).toMatch(/looked|searched|checked/i);
  });

  it('adds nothing when there is nothing to add', () => {
    const why = diagnoseNoSession({
      everConnected: false,
      initialized: false,
      listening: [3000],
      port: 4400,
    });
    expect(why).not.toMatch(/I looked in:/);
  });
});
