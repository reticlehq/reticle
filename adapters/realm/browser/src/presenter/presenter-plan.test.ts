import { afterEach, describe, expect, it } from 'vitest';
import { ReticleCommand, ScriptStatus, type PlanView } from '@reticlehq/core';
import { Presenter } from './presenter.js';

const view = (refund: ScriptStatus, audit: ScriptStatus): PlanView => ({
  parallel: 2,
  lanes: [
    {
      id: 'A',
      journeys: [
        {
          id: 'signin',
          title: 'Sign in',
          waitsOn: [],
          status: ScriptStatus.PASSED,
          steps: [{ label: 'Replay signin', status: ScriptStatus.PASSED }],
        },
        {
          id: 'refund',
          title: 'Refund an order',
          persona: 'Support agent',
          waitsOn: [],
          status: refund,
          steps: [
            { label: 'Replay refund-flow to step 3', status: ScriptStatus.PASSED },
            { label: 'Branch at shared: full / partial', status: refund },
          ],
        },
      ],
    },
    {
      id: 'B',
      journeys: [
        {
          id: 'audit',
          title: 'Audit the refund',
          waitsOn: ['refund'],
          status: audit,
          steps: [{ label: 'Replay audit-log', status: audit }],
        },
      ],
    },
  ],
});

const push = (presenter: Presenter, plan: PlanView): void =>
  presenter.handlePush({ name: ReticleCommand.PLAN, args: { ...plan } });
const card = (key: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-reticle-plan-journey="${key}"]`);

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the Harness plan on the Agent Log', () => {
  it('draws lanes side by side, opens the journey being driven, and follows it as it ends', () => {
    const presenter = new Presenter({});
    presenter.mount();
    const board = document.querySelector<HTMLElement>('[data-reticle-plan]');
    expect(board?.hidden).toBe(true);

    push(presenter, view(ScriptStatus.RUNNING, ScriptStatus.PENDING));
    expect(board?.hidden).toBe(false);
    expect(document.querySelectorAll('.reticle-plan-lane')).toHaveLength(2);
    expect(card('A/refund')?.getAttribute('data-status')).toBe(ScriptStatus.RUNNING);
    expect(card('A/refund')?.textContent).toContain('Branch at shared');
    expect(card('A/refund')?.textContent).toContain('Support agent');
    expect(card('B/audit')?.textContent).toContain('waits on refund');
    expect(card('B/audit')?.getAttribute('aria-expanded')).toBe('false');

    push(presenter, view(ScriptStatus.FAILED, ScriptStatus.BLOCKED));
    expect(card('A/refund')?.getAttribute('data-status')).toBe(ScriptStatus.FAILED);
    expect(card('B/audit')?.getAttribute('data-status')).toBe(ScriptStatus.BLOCKED);
    expect(board?.textContent).toContain('1 of 3 passed');
    presenter.destroy();
  });

  it('hides when asked, and comes back for the next drive', () => {
    const presenter = new Presenter({});
    presenter.mount();
    push(presenter, view(ScriptStatus.RUNNING, ScriptStatus.PENDING));
    document.querySelector<HTMLElement>('[data-reticle-plan-close]')?.click();
    const board = document.querySelector<HTMLElement>('[data-reticle-plan]');
    expect(board?.hidden).toBe(true);
    push(presenter, view(ScriptStatus.PASSED, ScriptStatus.RUNNING));
    expect(board?.hidden).toBe(true);
    const fresh = view(ScriptStatus.PENDING, ScriptStatus.PENDING);
    fresh.lanes[0]?.journeys.forEach((j) => (j.status = ScriptStatus.PENDING));
    push(presenter, fresh);
    expect(board?.hidden).toBe(false);
    presenter.destroy();
  });
});
