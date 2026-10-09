import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HarnessConfig } from '@reticlehq/core';
import {
  ANNOTATIONS_HTML,
  CHAT_VIEWS_HTML,
  CHAT_VIEWS_NAV_HTML,
  FLOWS_PAGE_HTML,
  ChatViews,
} from './presenter-chat-views.js';

const mountViews = (onHarness = vi.fn()) => {
  document.body.innerHTML = `<div data-reticle-overlay><div data-reticle-chat-panel>${CHAT_VIEWS_HTML}<section class="reticle-chat-view" aria-label="Agent Log"></section></div>${FLOWS_PAGE_HTML}${ANNOTATIONS_HTML}${CHAT_VIEWS_NAV_HTML}</div>`;
  const root = document.querySelector<HTMLElement>('[data-reticle-overlay]');
  if (null === root) throw new Error('chat panel failed to mount');
  const onImpact = vi.fn();
  const onOpenChat = vi.fn();
  const views = new ChatViews(onHarness, onImpact, onOpenChat);
  views.mount(root);
  return { root, views, onHarness, onImpact, onOpenChat };
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
  it('leaves the signed-out ask to the shared rail rather than asking twice', () => {
    const { root, views } = mountViews();
    views.paintAccount({ signedIn: false });
    expect(root.querySelector<HTMLElement>('[data-reticle-harness-spot]')?.hidden).toBe(true);
    expect(root.querySelector('[data-reticle-harness-switch]')).toBeNull();
  });

  it('heads every state with what Harness does, in plain words', () => {
    const { root, views } = mountViews();
    views.paintAccount({ signedIn: true });
    for (const config of [
      undefined,
      { ...entitled, harnessEntitled: false },
      { ...entitled, providerReady: false },
      entitled,
    ]) {
      views.paintHarness(config);
      expect(root.querySelector('.reticle-harness-title')?.textContent).toBe(
        'Let Reticle test this page',
      );
    }
  });

  it('explains missing project access with one link and no dead switch', () => {
    const { root, views } = mountViews();
    views.paintAccount({ signedIn: true });
    views.paintHarness(undefined);
    // Says exactly what to run, and where.
    expect(root.textContent).toContain('reticle connect');
    expect(root.textContent).toContain('app folder');
    // A disabled switch with nothing behind it was one more control to puzzle over.
    expect(root.querySelector('[data-reticle-harness-switch]')).toBeNull();
    expect(root.querySelectorAll('.reticle-harness-link')).toHaveLength(1);
    expect(root.querySelector('.reticle-harness-link')?.textContent).toContain('Set up');
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

  it('says how many Harness credits are left above Run Harness', () => {
    const { root, views } = mountViews();
    views.paintAccount({ signedIn: true });
    views.paintHarness({ ...entitled, credits: { used: 188, limit: 500 } });
    expect(root.textContent).toContain('312 of 500 Harness credits left this month');
    expect(root.querySelector('[data-reticle-harness-switch]')).not.toBeNull();
  });

  it('points at Pro, not at a dead switch, once the credits are spent', () => {
    const { root, views } = mountViews();
    views.paintAccount({ signedIn: true });
    views.paintHarness({ ...entitled, credits: { used: 500, limit: 500 } });
    expect(root.textContent).toContain('All 500 Harness credits used this month');
    expect(root.querySelector('.reticle-harness-link')?.textContent).toContain('Pro');
    expect(root.querySelector('[data-reticle-harness-switch]')).toBeNull();
  });

  it('shows setup instead of an active switch until the model provider is ready', () => {
    const { root, views } = mountViews();
    views.paintAccount({ signedIn: true });
    views.paintHarness({ ...entitled, providerReady: false });
    expect(root.textContent).toContain('Choose a model provider');
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
    views.paintHarness(undefined);
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
    views.paintHarness(undefined);
    expect(root.querySelector('.reticle-harness-link')?.getAttribute('href')).toBe(
      'https://app.reticle.sh/settings?group=project#model',
    );
  });

  it('says in words what the switch allows, and that off blocks every run', () => {
    const { root, views } = mountViews();
    views.paintAccount({ signedIn: true });
    views.paintHarness(entitled);
    const toggle = root.querySelector('[data-reticle-harness-switch]');
    expect(toggle?.getAttribute('aria-label')).toBe('Allow Reticle to drive this project');
    expect(root.querySelector('.reticle-harness-switch-label')?.textContent).toBe('Allowed');
    // On by default: the copy says Run Harness starts a drive, not that the switch does.
    expect(root.textContent).toContain('Run Harness');
    views.paintHarness({ ...entitled, harnessEnabled: false });
    expect(root.querySelector('.reticle-harness-switch-label')?.textContent).toBe('Not allowed');
    expect(root.textContent).toContain('Driving is turned off for this project');
  });

  it('toggles only when the server reports an entitled, ready workspace', () => {
    const { root, views, onHarness } = mountViews();
    views.paintAccount({ signedIn: true });
    views.paintHarness({ ...entitled, harnessEnabled: false });
    const toggle = root.querySelector<HTMLButtonElement>('[data-reticle-harness-switch]');
    if (null === toggle) throw new Error('eligible Harness toggle is missing');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    toggle.click();
    expect(onHarness).toHaveBeenCalledWith(true);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    views.paintHarness({ ...entitled, harnessEnabled: true });
    expect(root.querySelector('[data-reticle-harness-switch]')?.getAttribute('aria-checked')).toBe(
      'true',
    );
    const enabledToggle = root.querySelector<HTMLButtonElement>('[data-reticle-harness-switch]');
    if (null === enabledToggle) throw new Error('enabled Harness toggle is missing');
    enabledToggle.click();
    expect(onHarness).toHaveBeenLastCalledWith(false);
    expect(enabledToggle.getAttribute('aria-checked')).toBe('false');
    views.paintHarness({ ...entitled, harnessEnabled: false });
    expect(root.querySelector('[data-reticle-harness-switch]')?.getAttribute('aria-checked')).toBe(
      'false',
    );
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
    const drive = { run: vi.fn(), stop: vi.fn() };
    document.body.innerHTML = `<div data-reticle-overlay><div data-reticle-chat-panel>${CHAT_VIEWS_HTML}</div></div>`;
    const root = document.querySelector<HTMLElement>('[data-reticle-overlay]');
    if (null === root) throw new Error('chat panel failed to mount');
    const views = new ChatViews(vi.fn(), vi.fn(), vi.fn(), drive);
    views.mount(root);
    views.paintAccount({ signedIn: true });
    views.paintHarness(entitled);
    return { root, views, drive };
  };

  it('labels the persona field and gives Run Harness the full width', () => {
    const { root } = mountWithDrive();
    const input = root.querySelector<HTMLInputElement>('[data-reticle-harness-persona]');
    const label = root.querySelector(`label[for="${input?.id ?? ''}"]`);
    expect(label?.textContent).toBe('Act as… (optional)');
    expect(input?.placeholder).toBe('e.g. a first-time shopper');
    expect(root.querySelector('[data-reticle-harness-run]')?.classList).toContain(
      'reticle-harness-run',
    );
  });

  it('cannot start a run while the switch is off', () => {
    const { root, views, drive } = mountWithDrive();
    views.paintHarness({ ...entitled, harnessEnabled: false });
    const run = root.querySelector<HTMLButtonElement>('[data-reticle-harness-run]');
    expect(run?.disabled).toBe(true);
    run?.click();
    expect(drive.run).not.toHaveBeenCalled();
  });

  it('starts a drive with the persona typed beside Run Harness', () => {
    const { root, drive } = mountWithDrive();
    const input = root.querySelector<HTMLInputElement>('[data-reticle-harness-persona]');
    if (null === input) throw new Error('no persona field');
    input.value = '  a returning shopper ';
    root.querySelector<HTMLElement>('[data-reticle-harness-run]')?.click();
    expect(drive.run).toHaveBeenCalledWith('a returning shopper');
  });

  it('starts a drive with no persona when none was typed', () => {
    const { root, drive } = mountWithDrive();
    root.querySelector<HTMLElement>('[data-reticle-harness-run]')?.click();
    expect(drive.run).toHaveBeenCalledWith(undefined);
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
