import { describe, expect, it } from 'vitest';

import { attachTab, detachTabs, pickTab } from './attach-tab.js';

// The browser side could not reach a tab the person had open: `reticle drive` opened its own tab in
// an isolated context, signed in to nothing. Gmail and the AWS console were open in the person's
// Dia, and the agent had to read them from the outside, through the operating system.
describe('attach to a tab that is open in the person browser', () => {
  const tab = (url: string) => ({ url: () => url });

  it('picks the one tab whose address holds the words', () => {
    const tabs = [tab('https://mail.google.com/mail/u/0/'), tab('https://settings.aws.com/team')];
    expect(pickTab(tabs, 'settings.aws.com')).toEqual({ tab: tabs[1] });
  });

  it('refuses no match and two matches, and names only the origins open', () => {
    const tabs = [
      tab('https://mail.google.com/mail/u/0/#inbox/secret-thread'),
      tab('https://mail.google.com/mail/u/1/'),
    ];
    const none = pickTab(tabs, 'slack.com');
    expect('error' in none && none.error).toContain('https://mail.google.com');
    // A path can hold a private word: the refusal gives origins, never whole addresses.
    expect(JSON.stringify(none)).not.toContain('secret-thread');
    const two = pickTab(tabs, 'mail.google.com');
    expect('error' in two && two.error).toContain('2 tabs');
  });

  // Over the debugging port every tab of the profile is in reach, a password vault too. A vault
  // or a sign-in page is never joined, whatever the agent asks: its content is the person's
  // secrets, and the attach sets the page's security policy aside.
  it('never picks a password vault or a sign-in page', () => {
    for (const url of [
      'https://vault.bitwarden.com/#/vault',
      'https://my.1password.com/home',
      'https://lastpass.com/vault/',
      'https://app.dashlane.com/',
      'https://keepersecurity.com/vault/',
      'https://accounts.google.com/signin',
    ]) {
      const picked = pickTab([tab(url)], new URL(url).host);
      expect('error' in picked && picked.error).toContain('never joins');
    }
  });

  it('lets the reader through the page security, reloads, and puts the reader in', async () => {
    const calls: string[] = [];
    const page = {
      url: () => 'https://settings.aws.com/team',
      title: () => Promise.resolve('Team'),
      reload: () => {
        calls.push('reload');
        return Promise.resolve(null);
      },
      addInitScript: (script: string) => {
        calls.push(`init:${script}`);
        return Promise.resolve();
      },
      evaluate: (script: string) => {
        calls.push(`now:${script}`);
        return Promise.resolve(undefined);
      },
      context: () => ({
        newCDPSession: () =>
          Promise.resolve({
            send: (method: string) => {
              calls.push(method);
              return Promise.resolve({});
            },
          }),
        grantPermissions: (permissions: string[], { origin }: { origin: string }) => {
          calls.push(`grant:${permissions.join()}:${origin}`);
          return Promise.resolve();
        },
      }),
    };
    const browser = { contexts: () => [{ pages: () => [page] }] };
    const attached = await attachTab({
      cdpUrl: 'http://127.0.0.1:9222',
      match: 'settings.aws.com',
      scriptFor: (url) => `reader for ${url}`,
      connect: () => Promise.resolve(browser),
    });
    expect(attached).toEqual({ url: 'https://settings.aws.com/team', title: 'Team' });
    expect(calls).toEqual([
      'Page.setBypassCSP',
      'grant:local-network-access:https://settings.aws.com',
      'reload',
      'init:reader for https://settings.aws.com/team',
      'now:reader for https://settings.aws.com/team',
      expect.stringContaining('local-network-access'),
    ]);
  });

  // A task ends with the tab as it was: its security policy on again, and no connection left open.
  it('puts the page security back and lets go of the browser on a detach', async () => {
    const calls: string[] = [];
    const page = {
      url: () => 'https://settings.aws.com/team',
      title: () => Promise.resolve('Team'),
      reload: () => Promise.resolve(null),
      addInitScript: () => Promise.resolve(),
      evaluate: () => Promise.resolve(undefined),
      context: () => ({
        newCDPSession: () =>
          Promise.resolve({
            send: (method: string, params?: { enabled?: boolean }) => {
              calls.push(`${method}:${String(params?.enabled)}`);
              return Promise.resolve({});
            },
          }),
      }),
    };
    const browser = {
      contexts: () => [{ pages: () => [page] }],
      close: () => {
        calls.push('close');
        return Promise.resolve();
      },
    };
    await attachTab({
      cdpUrl: 'http://127.0.0.1:9333',
      match: 'settings.aws.com',
      scriptFor: () => 'reader',
      connect: () => Promise.resolve(browser),
    });
    expect(await detachTabs('http://127.0.0.1:9333')).toBe(1);
    expect(calls).toEqual(['Page.setBypassCSP:true', 'Page.setBypassCSP:false', 'close']);
    expect(await detachTabs('http://127.0.0.1:9333')).toBe(0);
  });
});
