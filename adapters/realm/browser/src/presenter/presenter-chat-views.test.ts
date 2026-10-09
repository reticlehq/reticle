import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HarnessConfig } from '@reticlehq/core';
import {
  ANNOTATIONS_HTML,
  CHAT_VIEWS_HTML,
  CHAT_VIEWS_NAV_HTML,
  FLOWS_PAGE_HTML,
  ChatViews,
} from './presenter-chat-views.js';
import { PERSONAS } from './presenter-personas.js';

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
  const rows = (root: HTMLElement): number =>
    root.querySelectorAll('[data-reticle-harness-spot] .reticle-harness-row').length;

  it('signed out, is one row: a sentence and Sign in', () => {
    const { root, views } = mountViews();
    views.paintAccount({ signedIn: false });
    expect(rows(root)).toBe(1);
    expect(root.textContent).toContain('Sign in to use Harness');
    expect(root.querySelector('[data-reticle-account-signin]')).not.toBeNull();
  });

  it('shows nothing while the account is unknown, never a sign-in nag', () => {
    const { root, views } = mountViews();
    views.paintAccount(undefined);
    expect(rows(root)).toBe(0);
  });

  it('has no heading, no paragraph and no switch in any state: the log gets the room', () => {
    const { root, views } = mountViews();
    views.paintAccount({ signedIn: true });
    for (const config of [
      undefined,
      { ...entitled, harnessEntitled: false },
      { ...entitled, providerReady: false },
      { ...entitled, harnessEnabled: false },
      { ...entitled, credits: { used: 5, limit: 5 } },
    ]) {
      views.paintHarness(config);
      expect(rows(root)).toBe(1);
      expect(root.querySelector('.reticle-harness-title')).toBeNull();
      expect(root.querySelector('[data-reticle-harness-switch]')).toBeNull();
    }
  });

  it('explains missing project access in one row with one link', () => {
    const { root, views } = mountViews();
    views.paintAccount({ signedIn: true });
    views.paintHarness(undefined);
    expect(root.textContent).toContain('reticle connect');
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

  it("says how many credits are left in one small line, the platform's numbers", () => {
    const { root, views } = mountViews();
    views.paintAccount({ signedIn: true });
    views.paintHarness({ ...entitled, credits: { used: 294, limit: 5000 } });
    expect(root.querySelector('[data-reticle-foot-meta]')?.textContent).toBe('4,706 credits left');
  });

  it('once the credits are spent, says so in its row with the way to get more', () => {
    const { root, views } = mountViews();
    views.paintAccount({ signedIn: true });
    views.paintHarness({ ...entitled, credits: { used: 500, limit: 500 } });
    expect(root.textContent).toContain('No Harness credits left');
    expect(root.querySelector('.reticle-harness-link')?.textContent).toContain('Get more');
    expect(root.querySelector('[data-reticle-foot-meta]')?.textContent).toBe('');
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

  it('when Harness is off, says so and opens Settings, where the switch lives', () => {
    const { root, views, onHarness } = mountViews();
    views.paintAccount({ signedIn: true });
    views.paintHarness({ ...entitled, harnessEnabled: false });
    expect(root.textContent).toContain('Harness is off');
    root.querySelector<HTMLElement>('[data-reticle-harness-settings]')?.click();
    expect(onHarness).toHaveBeenCalledTimes(1);
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

  const pick = (root: HTMLElement, value: string): void => {
    const select = root.querySelector<HTMLSelectElement>('[data-reticle-harness-persona-pick]');
    if (null === select) throw new Error('no persona picker');
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  };

  it('is one row, "As [preset] Run Harness", First-time visitor by default, each with its hint', () => {
    const { root } = mountWithDrive();
    const select = root.querySelector<HTMLSelectElement>('[data-reticle-harness-persona-pick]');
    expect(root.querySelectorAll('.reticle-harness-row')).toHaveLength(1);
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
    expect(root.querySelectorAll('.reticle-harness-row')).toHaveLength(1);
    expect(root.querySelector('.reticle-harness-said')?.textContent).toBe(
      'Driving as Keyboard only · 7 steps',
    );
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
    // No Run button to press at all: the row says Harness is off and offers to turn it on.
    expect(root.querySelector('[data-reticle-harness-run]')).toBeNull();
    expect(root.querySelector('[data-reticle-harness-settings]')).not.toBeNull();
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
