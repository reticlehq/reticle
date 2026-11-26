import { describe, expect, it } from 'vitest';

import type { ToolDeps } from './tool-kit.js';
import { runAttachTab } from './attach-tab-tool.js';

// The agent could not reach a tab of the person's own browser: `reticle drive` opened a tab of its
// own, signed in to nothing. The tool joins an open tab and answers with the session it became.
describe('reticle_attach_tab', () => {
  const depsWith = (sessions: { id: string; url: string }[], minted: string[]): ToolDeps =>
    ({
      bridgePort: 14500,
      sessions: { all: () => sessions },
      nonces: {
        mint: ({ origin }: { origin?: string }) => {
          minted.push(origin ?? '');
          return { nonce: 'n1', expiresAt: 0 };
        },
      },
    }) as unknown as ToolDeps;

  it('answers with the session of the tab once its reader connects', async () => {
    const sessions = [{ id: 'old', url: 'https://mail.google.com/' }];
    const minted: string[] = [];
    const deps = depsWith(sessions, minted);
    const answer = await runAttachTab(
      deps,
      { match: 'settings.aws.com', waitMs: 2000 },
      {
        bundle: 'READER',
        attach: (opts) => {
          // The reader connects while the tool waits.
          setTimeout(
            () => sessions.push({ id: 'cu-new', url: 'https://settings.aws.com/team' }),
            50,
          );
          expect(opts.scriptFor('https://settings.aws.com/team')).toContain('n1');
          return Promise.resolve({ url: 'https://settings.aws.com/team', title: 'Team' });
        },
      },
    );
    expect(answer).toMatchObject({ ok: true, sessionId: 'cu-new', title: 'Team' });
    // The pass is for the origin of the tab, never for every origin.
    expect(minted).toEqual(['https://settings.aws.com']);
  });

  // Dia keeps each profile in its own browser context. The grant reached only the default one, so
  // the Slack tab of another profile held the reader, waited on a permission prompt, and the
  // attach said only "no session joined".
  it('says that the tab waits on the local network prompt when the grant did not reach it', async () => {
    const deps = depsWith([], []);
    const answer = await runAttachTab(
      deps,
      { match: 'app.slack.com', waitMs: 300 },
      {
        bundle: 'READER',
        attach: () =>
          Promise.resolve({
            url: 'https://app.slack.com/',
            title: 'Slack',
            localNetwork: 'prompt',
          }),
      },
    );
    expect(answer['ok']).toBe(false);
    expect(String(answer['error'])).toContain('local network');
    expect(String(answer['error'])).toContain('profile to the front');
  });

  it('says what to do when no daemon pass can be made', async () => {
    const deps = { bridgePort: 14500, sessions: { all: () => [] } } as unknown as ToolDeps;
    const answer = await runAttachTab(deps, { match: 'x' }, {});
    expect(answer['ok']).toBe(false);
    expect(String(answer['error'])).toContain('daemon');
  });
});
