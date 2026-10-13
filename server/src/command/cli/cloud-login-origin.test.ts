/**
 * The approval page a sign-in opens says where the sign-in started, so the platform can attribute a
 * signup to the terminal or to the HUD. It used to open the URL the cloud returned unchanged, and
 * every signup from Reticle read as having come from nowhere.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const opened: string[] = [];
vi.mock('./auth/device-flow.js', async (original) => ({
  ...(await original<typeof import('./auth/device-flow.js')>()),
  openBrowser: (url: string) => opened.push(url),
}));

const { cmdLogin, hudSignIn } = await import('./cloud-login.js');
const { LoginOrigin, withLoginOrigin } = await import('./auth/device-flow.js');

/** A cloud that starts a device flow and then denies it, so nothing is written. */
function deviceCloud(): void {
  vi.stubGlobal('fetch', (url: string) => {
    const body = url.endsWith('/v1/auth/device/start')
      ? {
          deviceCode: 'd',
          userCode: 'U',
          verificationUri: 'https://app.test/device',
          verificationUriComplete: 'https://app.test/device?code=U',
          interval: 0,
          expiresAt: Date.now() + 60_000,
        }
      : { status: 'denied' };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  });
}

afterEach(() => {
  opened.length = 0;
  vi.unstubAllGlobals();
});

describe('where a sign-in started', () => {
  it('appends `from`, keeping the query the cloud sent', () => {
    expect(withLoginOrigin('https://app.test/device?code=U', LoginOrigin.TERMINAL)).toBe(
      'https://app.test/device?code=U&from=terminal',
    );
    expect(withLoginOrigin('https://app.test/device', LoginOrigin.HUD)).toBe(
      'https://app.test/device?from=hud',
    );
  });

  it('leaves a URL it cannot parse as the cloud sent it', () => {
    expect(withLoginOrigin('not a url', LoginOrigin.HUD)).toBe('not a url');
  });

  it('`reticle connect` / `reticle login` opens the page as from=terminal', async () => {
    deviceCloud();
    await cmdLogin(['--url', 'https://api.test'], () => Promise.resolve(0), false);
    expect(opened).toEqual(['https://app.test/device?code=U&from=terminal']);
  });

  it("the HUD's sign-in opens it as from=hud", async () => {
    deviceCloud();
    const seen: string[] = [];
    await new Promise<void>((resolve) => {
      hudSignIn(
        () => undefined,
        undefined,
        (url) => {
          seen.push(url);
          resolve();
        },
      )();
    });
    expect(seen).toEqual(['https://app.test/device?code=U&from=hud']);
  });
});
