import { describe, expect, it } from 'vitest';
import { InitConfirmation } from '@reticlehq/core';
import {
  confirmAppConnected,
  confirmInstall,
  confirmationMessage,
  type ConfirmDeps,
} from './confirm.js';

const PORT = 4400;

/** Each entry is one poll's answer: the session ids connected, or null for "no daemon". */
function deps(
  polls: readonly (readonly string[] | null)[],
  extra: Partial<ConfirmDeps> = {},
): ConfirmDeps {
  let clock = 0;
  let i = 0;
  return {
    listSessionIds: () => {
      const next = polls[Math.min(i, polls.length - 1)] ?? [];
      i++;
      return Promise.resolve(next);
    },
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    windowMs: 1000,
    pollMs: 250,
    ...extra,
  };
}

describe('confirmAppConnected', () => {
  it('reports connected as soon as a session that was not there before appears', async () => {
    expect(await confirmAppConnected(deps([[], [], ['app-1']]))).toBe(InitConfirmation.CONNECTED);
  });

  it('refuses to confirm on a session that was already connected', async () => {
    // The daemon is shared across every project on the machine, so another app's tab satisfies
    // "a session exists" and would confirm this install on somebody else's page.
    expect(await confirmAppConnected(deps([['other-app']]))).toBe(InitConfirmation.NO_SESSION);
  });

  it('reports no_daemon without spending the window when nothing answers', async () => {
    let polls = 0;
    const counted: ConfirmDeps = {
      ...deps([null]),
      listSessionIds: () => {
        polls++;
        return Promise.resolve(null);
      },
    };
    expect(await confirmAppConnected(counted)).toBe(InitConfirmation.NO_DAEMON);
    // A bound, not a duration: nothing can connect to a port nobody is listening on, so one look
    // settles it. Polling on would spend the whole window to learn what the first answer said.
    expect(polls).toBe(1);
  });

  it('reports no_session when the daemon is up and the window runs out', async () => {
    expect(await confirmAppConnected(deps([[]]))).toBe(InitConfirmation.NO_SESSION);
  });
});

describe('confirmationMessage', () => {
  it('marks a connected install as done and leaves no work outstanding', () => {
    const msg = confirmationMessage(InitConfirmation.CONNECTED, PORT);
    expect(msg).toContain('✓');
    expect(msg).not.toContain('⚠');
  });

  it('leaves no_daemon as a notice, not outstanding work — the install itself is fine', () => {
    const msg = confirmationMessage(InitConfirmation.NO_DAEMON, PORT);
    expect(msg).toContain('ℹ');
    expect(msg).not.toContain('⚠');
    expect(msg).toContain(String(PORT));
  });

  it('names the one outstanding step when no app connected', () => {
    const msg = confirmationMessage(InitConfirmation.NO_SESSION, PORT);
    expect(msg).toContain('⚠');
    expect(msg.toLowerCase()).toContain('dev server');
    // The daemon never manages a dev server, so the message hands the command over rather than
    // promising to run it — the agent is the party told to start one.
    expect(msg).toContain('status');
  });
});

describe('confirmInstall', () => {
  const printed: string[] = [];
  const io = {
    print: (line: string) => {
      printed.push(line);
    },
  };

  it('does not wait when nobody is at the terminal, and reports without a confirmation', async () => {
    printed.length = 0;
    const reported: unknown[] = [];
    let polls = 0;
    await confirmInstall(
      { ok: true, applied: 1, manual: 0, outcome: { ok: true } },
      io,
      {
        ...deps([[]]),
        listSessionIds: () => {
          polls++;
          return Promise.resolve([]);
        },
        interactive: false,
        port: PORT,
      },
      (o) => reported.push(o),
    );
    expect(polls, 'a non-TTY run must never block on the window').toBe(0);
    expect(reported).toEqual([{ ok: true }]);
    // ...but it must still SAY that the page half is unproven. The agent path is the prescribed
    // path — every skill and README block tells an agent to run this through a shell, which is
    // never a TTY — so staying silent here means the one message joining "init finished" to "an app
    // connected" is withheld from the majority of the people who run init.
    expect(printed.join('\n')).toContain('status');
    expect(
      printed.join('\n').toLowerCase(),
      'it must not claim an app connected — it did not look',
    ).not.toContain('an app is connected');
  });

  it('waits when a human is watching, prints the verdict and puts it on the outcome', async () => {
    printed.length = 0;
    const reported: unknown[] = [];
    await confirmInstall(
      { ok: true, applied: 1, manual: 0, outcome: { ok: true, stack: 'vite' } },
      io,
      { ...deps([[], ['app-1']]), interactive: true, port: PORT },
      (o) => reported.push(o),
    );
    expect(printed.join('\n')).toContain('✓');
    expect(reported).toEqual([
      { ok: true, stack: 'vite', confirmation: InitConfirmation.CONNECTED },
    ]);
  });

  it('reports nothing when there is no outcome — a dry run is a preview, not an install', async () => {
    printed.length = 0;
    const reported: unknown[] = [];
    await confirmInstall(
      { ok: true, applied: 0, manual: 0 },
      io,
      { ...deps([['app-1']]), interactive: true, port: PORT },
      (o) => reported.push(o),
    );
    expect(reported).toEqual([]);
    expect(printed).toEqual([]);
  });
});
