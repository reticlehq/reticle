import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HarnessConfig } from '@reticlehq/core';
import {
  ANNOTATIONS_HTML,
  CHAT_VIEWS_HTML,
  CHAT_VIEWS_NAV_HTML,
  FLOWS_PAGE_HTML,
  HARNESS_PAGE_HTML,
  ChatViews,
} from './presenter-chat-views.js';
import { PERSONAS } from './presenter-personas.js';

const driveHost = () => ({ run: vi.fn(), stop: vi.fn(), setHarness: vi.fn(), link: vi.fn() });

const mountViews = (drive = driveHost()) => {
  document.body.innerHTML = `<div data-reticle-overlay><div data-reticle-chat-panel>${CHAT_VIEWS_HTML}<section class="reticle-chat-view" aria-label="Agent Log"></section></div>${FLOWS_PAGE_HTML}${HARNESS_PAGE_HTML}${ANNOTATIONS_HTML}${CHAT_VIEWS_NAV_HTML}</div>`;
  const root = document.querySelector<HTMLElement>('[data-reticle-overlay]');
  if (null === root) throw new Error('chat panel failed to mount');
  const onImpact = vi.fn();
  const onOpenChat = vi.fn();
  const views = new ChatViews(onImpact, onOpenChat, drive);
  views.mount(root);
  return { root, views, drive, onImpact, onOpenChat };
};

const entitled: HarnessConfig = {
  provider: 'jev',
  harnessEnabled: true,
  harnessEntitled: true,
  providerReady: true,
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('chat views and harness access states', () => {
  const rows = (root: HTMLElement): number =>
    root.querySelectorAll('[data-reticle-harness-page] .reticle-harness-row').length;
  const foot = (root: HTMLElement): HTMLElement | null =>
    root.querySelector<HTMLElement>('[data-reticle-harness-spot]');

  it('signed out, is one row: the free credits and the trial, and Sign in', () => {
    const { root, views } = mountViews();
    views.paintAccount({ signedIn: false });
    expect(rows(root)).toBe(1);
    expect(root.textContent).toContain(
      'Sign up: free credits to try Reticle · add a card for a 500-credit, 14-day trial',
    );
    expect(root.querySelector('[data-reticle-account-signin]')).not.toBeNull();
  });

  /** Signed out, the HUD asked three times at once; the rail under every page is the one ask. */
  it('signed out, the foot under the log asks nothing: the rail below is the one sign-in', () => {
    const { root, views } = mountViews();
    views.paintAccount({ signedIn: false });
    expect(foot(root)?.querySelector('[data-reticle-account-signin]') ?? null).toBeNull();
    expect(foot(root)?.textContent ?? '').toBe('');
  });

  it('shows nothing while the account is unknown, never a sign-in nag', () => {
    const { root, views } = mountViews();
    views.paintAccount(undefined);
    expect(rows(root)).toBe(0);
  });

  it('signed in, the foot is one button that names the state and opens the Harness page', () => {
    const { root, views, onOpenChat } = mountViews();
    views.paintAccount({ signedIn: true });
    // [config, what the row says beside "Harness", the switch: absent, or on/off]
    for (const [config, said, toggle] of [
      [undefined, 'Link project', null],
      [{ ...entitled, harnessEntitled: false }, 'Not on your plan', null],
      [{ ...entitled, providerReady: false }, 'No model provider', null],
      [{ ...entitled, harnessEnabled: false }, '', 'false'],
      [{ ...entitled, credits: { used: 5, limit: 5 } }, 'No credits', null],
      [{ ...entitled, credits: { used: 2, limit: 10, kind: 'free' } }, '8 credits', 'true'],
      [
        { ...entitled, credits: { used: 120, limit: 500, kind: 'trial', daysLeft: 9 } },
        '380 credits · 9 days',
        'true',
      ],
    ] as const) {
      views.paintHarness(config);
      expect(foot(root)?.querySelectorAll('.reticle-harness-row')).toHaveLength(1);
      expect(foot(root)?.querySelector('.reticle-harness-name')?.textContent).toBe('Harness');
      expect(foot(root)?.querySelector('.reticle-harness-state')?.textContent).toBe(said);
      expect(
        foot(root)?.querySelector('[data-reticle-harness-toggle]')?.getAttribute('aria-checked') ??
          null,
      ).toBe(toggle);
      expect(foot(root)?.querySelector('select, input, [data-reticle-harness-run]')).toBeNull();
      expect(rows(root)).toBe(1);
    }
    foot(root)?.querySelector<HTMLElement>('[data-reticle-harness-open]')?.click();
    expect(onOpenChat).toHaveBeenCalledWith('harness');
    expect(root.querySelector<HTMLElement>('[data-reticle-page-panel="harness"]')?.hidden).toBe(
      false,
    );
  });

  it('closes the Harness page when the person signs out: the page is for a signed-in person', () => {
    const { root, views } = mountViews();
    views.paintAccount({ signedIn: true });
    views.open('harness');
    views.paintAccount({ signedIn: false });
    expect(root.querySelector<HTMLElement>('[data-reticle-page-panel="harness"]')?.hidden).toBe(
      true,
    );
    // The rail under every page asks to sign in again; the foot does not ask a second time.
    expect(foot(root)?.querySelector('[data-reticle-account-signin]') ?? null).toBeNull();
  });

  it('an unlinked project is linked from the page, never by a command to type', () => {
    const { root, views, drive } = mountViews();
    views.paintAccount({ signedIn: true });
    views.paintHarness(undefined);
    expect(root.textContent).not.toContain('reticle connect');
    expect(root.textContent).toContain('This project is not on your dashboard yet.');
    const button = (): HTMLButtonElement | null =>
      root.querySelector<HTMLButtonElement>('[data-reticle-harness-link]');
    button()?.click();
    expect(drive.link).toHaveBeenCalledTimes(1);
    expect(button()?.textContent).toBe('Linking…');
    expect(button()?.disabled).toBe(true);
    button()?.click();
    expect(drive.link).toHaveBeenCalledTimes(1);
    // The daemon's next push carries the platform's config: linked, and the button is gone.
    views.paintHarness(entitled);
    expect(button()).toBeNull();
  });

  /*
   * Found live: a tab that named no project pressed Link, the daemon refused, and the button said
   * "Linking…", disabled, until the page was reloaded.
   */
  it('gives the Link button back when no link lands, so the person can try again', () => {
    vi.useFakeTimers();
    try {
      const { root, views, drive } = mountViews();
      views.paintAccount({ signedIn: true });
      views.paintHarness(undefined);
      const button = (): HTMLButtonElement | null =>
        root.querySelector<HTMLButtonElement>('[data-reticle-harness-link]');
      button()?.click();
      expect(button()?.disabled).toBe(true);
      // The daemon answered, and the project is still not linked.
      views.paintHarness(undefined);
      vi.advanceTimersByTime(20_000);
      expect(button()?.textContent).toBe('Link this project');
      expect(button()?.disabled).toBe(false);
      button()?.click();
      expect(drive.link).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the Harness value and setup link to signed-in users without entitlement', () => {
    const { root, views } = mountViews();
    views.paintAccount({ signedIn: true });
    views.paintHarness({ ...entitled, harnessEntitled: false });
    expect(root.textContent).toContain('Harness is not on your plan');
    expect(root.querySelector('.reticle-harness-link')?.textContent).toContain('See plans');
    // The console has no /harness page; it redirected to the home page. Credits live on Plan.
    expect(root.querySelector('.reticle-harness-link')?.getAttribute('href')).toBe(
      'https://app.reticle.sh/settings?group=billing',
    );
    expect(root.querySelector('[data-reticle-harness-switch]')).toBeNull();
  });

  it('switches the Harness from the Agent Log, without opening a page', () => {
    const { root, views, drive, onOpenChat } = mountViews();
    views.paintAccount({ signedIn: true });
    views.paintHarness(entitled);
    root.querySelector<HTMLElement>('[data-reticle-harness-toggle]')?.click();
    expect(drive.setHarness).toHaveBeenCalledWith(false);
    expect(onOpenChat).not.toHaveBeenCalled();
    views.paintHarness({ ...entitled, harnessEnabled: false });
    root.querySelector<HTMLElement>('[data-reticle-harness-toggle]')?.click();
    expect(drive.setHarness).toHaveBeenLastCalledWith(true);
  });

  it("says the credits once: compact in the row, the platform's sentence on hover and on the page", () => {
    const { root, views } = mountViews();
    const meta = (): string | null | undefined =>
      root.querySelector('[data-reticle-harness-page-meta]')?.textContent;
    const title = (): string | null | undefined =>
      root.querySelector('[data-reticle-harness-open]')?.getAttribute('title');
    views.paintAccount({ signedIn: true });
    views.paintHarness({ ...entitled, credits: { used: 294, limit: 5000 } });
    expect(meta()).toBe('294 of 5,000 credits used · 4,706 left');
    views.paintHarness({ ...entitled, credits: { used: 2, limit: 10, kind: 'free' } });
    expect(meta()).toBe('Free: 2 of 10 credits used · 8 left');
    views.paintHarness({
      ...entitled,
      credits: { used: 120, limit: 500, kind: 'trial', daysLeft: 9 },
    });
    expect(meta()).toBe('Trial: 120 of 500 credits used · 380 left · 9 days left');
    expect(title()).toBe('Trial: 120 of 500 credits used · 380 left · 9 days left');
    expect(root.querySelector('[data-reticle-foot-meta]')).toBeNull();
  });

  describe('no setup score gates the Harness', () => {
    it('with Harness off, says it is off and switches it on from the page, with no score', () => {
      const { root, views, drive } = mountViews();
      views.paintAccount({ signedIn: true });
      views.paintHarness({ ...entitled, harnessEnabled: false });
      expect(root.textContent).toContain('Harness is off');
      expect(root.textContent).not.toMatch(/Setup score|needs 80%|unlocks/);
      root.querySelector<HTMLElement>('[data-reticle-harness-switch]')?.click();
      expect(drive.setHarness).toHaveBeenCalledTimes(1);
    });

    it('offers Run, and no copy-prompt lock, whatever the instrumentation', () => {
      const { root, views } = mountViews();
      views.paintAccount({ signedIn: true });
      views.paintHarness(entitled);
      expect(root.querySelector('[data-reticle-harness-run]')).not.toBeNull();
      expect(root.querySelector('[data-reticle-harness-copy-prompt]')).toBeNull();
    });
  });

  it('once the credits are spent, says so in its row with the way to get more', () => {
    const { root, views } = mountViews();
    views.paintAccount({ signedIn: true });
    views.paintHarness({ ...entitled, credits: { used: 500, limit: 500 } });
    expect(root.textContent).toContain('No credits left');
    expect(root.querySelector('.reticle-harness-link')?.textContent).toContain('Get more');
    expect(root.querySelector('[data-reticle-harness-page-meta]')?.textContent).toBe('');
  });

  /*
   * The platform reports no credits left as `harnessEntitled: false`, so the row checked entitlement
   * first and told a workspace whose free credits ran out that Harness was "not on your plan".
   */
  describe('with no credits left, by the grant they came from', () => {
    const spent = (kind: 'free' | 'trial' | 'paid', limit: number): HarnessConfig => ({
      ...entitled,
      harnessEntitled: false,
      credits: { used: limit, limit, kind },
    });
    const links = (root: HTMLElement): (string | null)[] =>
      [...root.querySelectorAll('[data-reticle-harness-page] .reticle-harness-link')].map(
        (a) => a.textContent,
      );

    it('free: the platform’s number, and one link that starts the trial', () => {
      const { root, views } = mountViews();
      views.paintAccount({ signedIn: true });
      views.paintHarness(spent('free', 25));
      expect(root.textContent).toContain('Your 25 free credits are used.');
      expect(root.textContent).not.toContain('not on your plan');
      expect(links(root)).toEqual(['Add a card to start your 14-day trial ↗']);
      expect(root.querySelector('.reticle-harness-link')?.getAttribute('href')).toBe(
        'https://app.reticle.sh/settings?group=billing',
      );
      expect(root.textContent).not.toMatch(/Get more|Pro/);
    });

    it('trial: when Pro starts, and no offer to buy more', () => {
      const { root, views } = mountViews();
      views.paintAccount({ signedIn: true });
      views.paintHarness(spent('trial', 500));
      expect(root.textContent).toContain(
        'Your 500 trial credits are used. Pro starts when your trial ends.',
      );
      expect(root.textContent).not.toContain('Get more');
      expect(root.querySelector('.reticle-harness-link')?.getAttribute('href')).toBe(
        'https://app.reticle.sh/settings?group=billing',
      );
    });

    it('paid: when they renew', () => {
      const { root, views } = mountViews();
      views.paintAccount({ signedIn: true });
      views.paintHarness(spent('paid', 4000));
      expect(root.textContent).toContain(
        "This month's credits are used. They renew over the next 30 days.",
      );
      expect(root.textContent).not.toContain('not on your plan');
    });

    it('stays one row', () => {
      const { root, views } = mountViews();
      views.paintAccount({ signedIn: true });
      for (const kind of ['free', 'trial', 'paid'] as const) {
        views.paintHarness(spent(kind, 10));
        expect(rows(root)).toBe(1);
      }
    });
  });

  it('shows setup instead of an active switch until the model provider is ready', () => {
    const { root, views } = mountViews();
    views.paintAccount({ signedIn: true });
    views.paintHarness({ ...entitled, providerReady: false });
    expect(root.textContent).toContain('No model provider set');
    expect(root.querySelector('.reticle-harness-link')?.textContent).toContain('Set up');
    // The switch and provider live in Settings → Projects → Verification.
    expect(root.querySelector('.reticle-harness-link')?.getAttribute('href')).toBe(
      'https://app.reticle.sh/settings?group=project#model',
    );
    expect(root.querySelector('[data-reticle-harness-switch]')).toBeNull();
  });

  /*
   * A daemon pointed at a self-hosted or local platform sent every link to the hosted one. The base
   * is the platform the daemon read this config from, else the host this machine signed in to.
   */
  it('links to the platform the daemon talks to, not always the hosted one', () => {
    const { root, views } = mountViews();
    views.paintAccount({ signedIn: true, host: 'http://localhost:4100' });
    views.paintHarness({ ...entitled, providerReady: false });
    expect(root.querySelector('.reticle-harness-link')?.getAttribute('href')).toBe(
      'http://localhost:4100/settings?group=project#model',
    );
    views.paintHarness({
      ...entitled,
      harnessEntitled: false,
      platformUrl: 'https://reticle.internal.test',
    });
    expect(root.querySelector('.reticle-harness-link')?.getAttribute('href')).toBe(
      'https://reticle.internal.test/settings?group=billing',
    );
  });

  /*
   * Found live: the API and the console are two origins, so "Add a card…" built from the API's
   * origin opened a 404. The platform sends the console's own page as `planUrl`; the HUD uses it,
   * and Set up goes to the same origin.
   */
  it("links plans and set-up to the console the platform names, not the API's origin", () => {
    const { root, views } = mountViews();
    views.paintAccount({ signedIn: true, host: 'http://localhost:8890' });
    const split = {
      ...entitled,
      platformUrl: 'http://localhost:8890',
      planUrl: 'http://localhost:4320/settings?group=billing',
    };
    views.paintHarness({ ...split, credits: { used: 10, limit: 10, kind: 'free' } });
    expect(root.querySelector('.reticle-harness-link')?.getAttribute('href')).toBe(
      'http://localhost:4320/settings?group=billing',
    );
    views.paintHarness({ ...split, providerReady: false });
    expect(root.querySelector('.reticle-harness-link')?.getAttribute('href')).toBe(
      'http://localhost:4320/settings?group=project#model',
    );
  });

  /*
   * A paid user pressed Set up and landed on dashboard Settings showing "All projects" and no switch:
   * the link named no project. The console reads `?project=`, before the hash.
   */
  it('opens Set up on THIS project when the HUD knows its project id', () => {
    const { root, views } = mountViews();
    views.setProjectId('acme web/9f3c');
    views.paintAccount({ signedIn: true });
    views.paintHarness({ ...entitled, providerReady: false });
    expect(root.querySelector('.reticle-harness-link')?.getAttribute('href')).toBe(
      'https://app.reticle.sh/settings?group=project&project=acme%20web%2F9f3c#model',
    );
  });

  it('never links to a base that is not http(s)', () => {
    const { root, views } = mountViews();
    views.paintAccount({ signedIn: true, host: 'javascript:alert(1)' });
    views.paintHarness({ ...entitled, providerReady: false });
    expect(root.querySelector('.reticle-harness-link')?.getAttribute('href')).toBe(
      'https://app.reticle.sh/settings?group=project#model',
    );
  });

  it('when Harness is off, says so and switches it on from the page', () => {
    const { root, views, drive } = mountViews();
    views.paintAccount({ signedIn: true });
    views.paintHarness({ ...entitled, harnessEnabled: false });
    expect(root.textContent).toContain('Harness is off');
    root.querySelector<HTMLElement>('[data-reticle-harness-switch]')?.click();
    expect(drive.setHarness).toHaveBeenCalledTimes(1);
  });

  it('keeps Notes controls in one compact row', () => {
    const { root } = mountViews();
    const notes = root.querySelector('[data-reticle-page-panel="annotations"]');
    if (null === notes) throw new Error('Notes view is missing');
    const top = notes.querySelector('.reticle-annotations-tabs');
    if (null === top) throw new Error('Notes controls are missing');
    expect(notes.querySelector('.reticle-page-heading strong')?.textContent).toBe('Notes');
    expect(top.querySelector('[data-reticle-annotation-tab="current"]')).not.toBeNull();
    expect(top.querySelector('[data-reticle-annotation-tab="history"]')).not.toBeNull();
    expect(top.querySelector('[data-reticle-current-annotation-actions]')).not.toBeNull();
    // Add notes is the page's primary action, so it sits in the header beside the title.
    expect(
      notes.querySelector('.reticle-page-heading [data-reticle-annotate-btn]')?.textContent,
    ).toContain('Add notes');
    expect(top.querySelector('[data-reticle-copy-all-notes]')).not.toBeNull();
  });

  it('opens Agent Log, Saved Flows, Notes and Impact from their single toolbar entries', () => {
    const { root, onOpenChat, onImpact } = mountViews();
    for (const [view, label] of [
      ['activity', 'Agent log'],
      ['flows', 'Saved flows'],
      ['annotations', 'Notes'],
    ] as const) {
      const button = root.querySelector<HTMLButtonElement>(
        `[data-reticle-chat-view-btn="${view}"]`,
      );
      if (null === button) throw new Error(`${label} toolbar action is missing`);
      button.click();
      expect(onOpenChat).toHaveBeenLastCalledWith(view);
      expect(button.getAttribute('aria-current')).toBe('page');
      if ('activity' === view) {
        expect(root.querySelector('[data-reticle-chat-panel]')?.hasAttribute('hidden')).toBe(false);
      } else {
        expect(
          root.querySelector(`[data-reticle-page-panel="${view}"]`)?.hasAttribute('hidden'),
        ).toBe(false);
      }
    }
    const impact = root.querySelector<HTMLButtonElement>('[data-reticle-chat-impact]');
    if (null === impact) throw new Error('Impact toolbar action is missing');
    impact.click();
    expect(onImpact).toHaveBeenCalledOnce();
  });

  it('moves between Current and History without crowding the notes toolbar', () => {
    const { root } = mountViews();
    const current = root.querySelector<HTMLButtonElement>(
      '[data-reticle-annotation-tab="current"]',
    );
    const history = root.querySelector<HTMLButtonElement>(
      '[data-reticle-annotation-tab="history"]',
    );
    const actions = root.querySelector<HTMLElement>('[data-reticle-current-annotation-actions]');
    if (null === current || null === history || null === actions)
      throw new Error('Notes actions missing');
    history.click();
    expect(history.getAttribute('aria-pressed')).toBe('true');
    expect(actions.hidden).toBe(true);
    const addNotes = root.querySelector<HTMLButtonElement>('[data-reticle-annotate-btn]');
    if (null === addNotes) throw new Error('Add notes control is missing');
    addNotes.click();
    expect(current.getAttribute('aria-pressed')).toBe('true');
    expect(actions.hidden).toBe(false);
    current.click();
    expect(current.getAttribute('aria-pressed')).toBe('true');
    expect(actions.hidden).toBe(false);
  });
});

/*
 * The Harness switch only toggled the platform's autonomous mode; nothing on the panel could start
 * a drive. Run Harness starts one (persona optional); while it runs the panel shows its steps and
 * Stop, from the daemon's snapshot.
 */
describe('running the Harness from the panel', () => {
  const mountWithDrive = () => {
    const { root, views, drive } = mountViews();
    views.paintAccount({ signedIn: true });
    views.paintHarness(entitled);
    return { root, views, drive };
  };

  const pick = (root: HTMLElement, value: string): void => {
    const select = root.querySelector<HTMLSelectElement>('[data-reticle-harness-persona-pick]');
    if (null === select) throw new Error('no persona picker');
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  };

  it('is one row, "As [preset] Run Harness", First-time visitor by default, each with its hint', () => {
    const { root } = mountWithDrive();
    const select = root.querySelector<HTMLSelectElement>('[data-reticle-harness-persona-pick]');
    expect(root.querySelectorAll('[data-reticle-harness-page] .reticle-harness-row')).toHaveLength(
      1,
    );
    expect(root.querySelector(`label[for="${select?.id ?? ''}"]`)?.textContent).toBe('As');
    expect([...(select?.options ?? [])].map((o) => o.textContent)).toEqual([
      ...PERSONAS.map((p) => p.label),
      'Custom…',
    ]);
    expect(select?.value).toBe('first-time');
    // The hint is the select's description and tooltip, not a line that takes log space.
    expect(select?.title).toBe(PERSONAS[0].hint);
    const described = select?.getAttribute('aria-describedby') ?? '';
    expect(root.querySelector(`#${described}`)?.textContent).toBe(PERSONAS[0].hint);
    expect(root.querySelector('[data-reticle-harness-persona]')).toBeNull();
  });

  it('runs as the picked preset, sending its sentence as the persona', () => {
    const { root, drive } = mountWithDrive();
    pick(root, 'keyboard');
    expect(root.querySelector<HTMLSelectElement>('select')?.title).toBe(PERSONAS[3].hint);
    root.querySelector<HTMLElement>('[data-reticle-harness-run]')?.click();
    expect(drive.run).toHaveBeenCalledWith(`Keyboard only: ${PERSONAS[3].hint}`);
  });

  it('while its drive runs, the same row says who it is driving as, the steps, and Stop', () => {
    const { root, views } = mountWithDrive();
    pick(root, 'keyboard');
    root.querySelector<HTMLElement>('[data-reticle-harness-run]')?.click();
    views.paintDrive({ runId: 'harness-1', steps: 7 });
    // The foot row and the page both say it, with Stop; the foot row's steps open the page.
    for (const [scope, said] of [
      ['[data-reticle-harness-spot]', '.reticle-harness-state'],
      ['[data-reticle-harness-page]', '.reticle-harness-said'],
    ] as const) {
      expect(root.querySelectorAll(`${scope} .reticle-harness-row`)).toHaveLength(1);
      expect(root.querySelector(`${scope} ${said}`)?.textContent).toBe(
        'Driving as Keyboard only · 7 steps',
      );
      expect(root.querySelector(`${scope} [data-reticle-harness-stop]`)).not.toBeNull();
    }
    expect(
      root.querySelector('[data-reticle-harness-spot] [data-reticle-harness-open]'),
    ).not.toBeNull();
  });

  it('keeps Run in its slot through a whole run: Starting…, Stop, then Run again, never remounted', () => {
    const { root, views } = mountWithDrive();
    const pageButton = (): HTMLButtonElement | null =>
      root.querySelector<HTMLButtonElement>('[data-reticle-harness-page] button');
    const footOpen = (): Element | null =>
      root.querySelector('[data-reticle-harness-spot] [data-reticle-harness-open]');
    const footSlot = (): Element | null =>
      root.querySelector('[data-reticle-harness-spot] .reticle-harness-row > :last-child');
    const run = pageButton();
    const open = footOpen();
    const slot = footSlot();
    expect(run?.textContent).toBe('Run Harness');
    run?.click();
    // Pressed: the same button says so at once, and a press while it starts does nothing twice.
    expect(pageButton()).toBe(run);
    expect(run?.disabled).toBe(true);
    expect(run?.textContent).toBe('Starting…');
    // Every step is a full snapshot push: account, config and drive, the way presenter.ts paints it.
    const push = (drive: { runId: string; steps: number } | undefined): void => {
      views.paintHarness(entitled);
      views.paintDrive(drive);
      views.paintAccount({ signedIn: true });
      expect(pageButton(), JSON.stringify(drive)).toBe(run);
      expect(footOpen(), JSON.stringify(drive)).toBe(open);
      expect(footSlot(), JSON.stringify(drive)).toBe(slot);
    };
    // A push that lands before the daemon registered the drive must not bring Run back for a beat.
    push(undefined);
    expect(run?.textContent).toBe('Starting…');
    for (const steps of [0, 1, 2, 3]) {
      push({ runId: 'harness-1', steps });
      expect(run?.textContent).toBe('Stop');
      expect(run?.hasAttribute('data-reticle-harness-stop')).toBe(true);
      expect(run?.disabled).toBe(false);
    }
    push(undefined);
    expect(run?.textContent).toBe('Run Harness');
    expect(run?.hasAttribute('data-reticle-harness-run')).toBe(true);
    expect(run?.disabled).toBe(false);
  });

  // Night 7b: with the cloud unreachable the daemon answered in 0.15 s, and the page sat on
  // Starting… for the whole 20 s fallback before it showed the line.
  it("shows why no drive started as soon as the daemon says it, not after Starting…'s fallback", () => {
    const { root, views } = mountWithDrive();
    // An earlier word on this tab: it is not the answer to this press.
    views.paintDrive(undefined, {
      said: 'The page reloaded, so this run stopped. Run again.',
      seq: 1,
    });
    const run = root.querySelector<HTMLButtonElement>('[data-reticle-harness-run]');
    run?.click();
    views.paintDrive(undefined, {
      said: 'The page reloaded, so this run stopped. Run again.',
      seq: 1,
    });
    expect(run?.textContent).toBe('Starting…');
    views.paintDrive(undefined, { said: 'Reticle Cloud at http://x did not answer.', seq: 2 });
    expect(run?.textContent).toBe('Run Harness');
    expect(run?.disabled).toBe(false);
    expect(root.querySelector('[data-reticle-harness-page]')?.textContent).toContain(
      'Reticle Cloud at http://x did not answer.',
    );
  });

  it('gives Run back if the drive never starts', () => {
    vi.useFakeTimers();
    try {
      const { root } = mountWithDrive();
      const run = root.querySelector<HTMLButtonElement>('[data-reticle-harness-run]');
      run?.click();
      expect(run?.disabled).toBe(true);
      vi.advanceTimersByTime(60_000);
      expect(run?.disabled).toBe(false);
      expect(run?.textContent).toBe('Run Harness');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reveals the text box for Custom and runs with the words typed there', () => {
    const { root, drive } = mountWithDrive();
    pick(root, 'custom');
    const input = root.querySelector<HTMLInputElement>('[data-reticle-harness-persona]');
    if (null === input) throw new Error('no custom field');
    input.value = '  a returning shopper ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector<HTMLElement>('[data-reticle-harness-run]')?.click();
    expect(drive.run).toHaveBeenCalledWith('a returning shopper');
  });

  it('runs with no persona when Custom is empty', () => {
    const { root, drive } = mountWithDrive();
    pick(root, 'custom');
    root.querySelector<HTMLElement>('[data-reticle-harness-run]')?.click();
    expect(drive.run).toHaveBeenCalledWith(undefined);
  });

  it('remembers the last pick per project, and works when storage throws', () => {
    localStorage.clear();
    const first = mountWithDrive();
    first.views.setProjectId('shop');
    pick(first.root, 'admin');
    const again = mountWithDrive();
    again.views.setProjectId('shop');
    expect(again.root.querySelector<HTMLSelectElement>('select')?.value).toBe('admin');
    again.views.setProjectId('other');
    expect(again.root.querySelector<HTMLSelectElement>('select')?.value).toBe('first-time');
    const broken = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    again.views.setProjectId('shop');
    expect(again.root.querySelector<HTMLSelectElement>('select')?.value).toBe('first-time');
    broken.mockRestore();
  });

  it('keeps the custom words through a repaint', () => {
    const { root, views } = mountWithDrive();
    pick(root, 'custom');
    const input = root.querySelector<HTMLInputElement>('[data-reticle-harness-persona]');
    if (null === input) throw new Error('no custom field');
    input.value = 'half typed';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    views.paintHarness({ ...entitled });
    expect(root.querySelector<HTMLInputElement>('[data-reticle-harness-persona]')?.value).toBe(
      'half typed',
    );
  });

  it('cannot start a run while the switch is off', () => {
    const { root, views, drive } = mountWithDrive();
    views.paintHarness({ ...entitled, harnessEnabled: false });
    // No Run button to press at all: the page says Harness is off and offers to switch it on.
    expect(root.querySelector('[data-reticle-harness-run]')).toBeNull();
    expect(root.querySelector('[data-reticle-harness-switch]')).not.toBeNull();
    expect(drive.run).not.toHaveBeenCalled();
  });

  it('shows the running drive with Stop, and Run again once it has ended', () => {
    const { root, views, drive } = mountWithDrive();
    views.paintDrive({ runId: 'harness-1', steps: 7 });
    expect(root.querySelector('[data-reticle-harness-run]')).toBeNull();
    expect(root.textContent).toContain('7 steps');
    root.querySelector<HTMLElement>('[data-reticle-harness-stop]')?.click();
    expect(drive.stop).toHaveBeenCalled();
    views.paintDrive(undefined);
    expect(root.querySelector('[data-reticle-harness-run]')).not.toBeNull();
  });
});

/**
 * A drive's navigations reload the page, and the HUD with it. After a run that ended on a reload the
 * HUD came back on an empty Agent Log, the result only under Harness, and at every lane change the
 * Stop button a keyboard user was on was a new element without focus. The view and the focus on the
 * run control come back with the HUD.
 */
describe('the HUD after the reload a drive causes', () => {
  afterEach(() => sessionStorage.clear());
  const signedIn = (views: ChatViews): void => {
    views.paintAccount({ signedIn: true });
    views.paintHarness(entitled);
  };

  it('comes back on the page that was open, before the account is known', () => {
    const first = mountViews();
    signedIn(first.views);
    first.views.open('harness');
    first.views.teardown();
    const again = mountViews();
    expect(again.root.getAttribute('data-reticle-page-open')).toBe('harness');
    signedIn(again.views);
    expect(again.root.getAttribute('data-reticle-page-open')).toBe('harness');
  });

  it('gives focus back to Stop when it had it', () => {
    const first = mountViews();
    signedIn(first.views);
    first.views.open('harness');
    first.views.paintDrive({ runId: 'harness-1', steps: 3 });
    first.root
      .querySelector<HTMLElement>('[data-reticle-harness-page] [data-reticle-harness-stop]')
      ?.focus();
    first.views.teardown();
    const again = mountViews();
    signedIn(again.views);
    again.views.paintDrive({ runId: 'harness-1', steps: 4 });
    expect(document.activeElement?.hasAttribute('data-reticle-harness-stop')).toBe(true);
  });
});
