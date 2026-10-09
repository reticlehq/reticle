import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_LINK_HTML, AgentLinkView, agentsLine } from './presenter-agent-link.js';

afterEach(() => {
  document.body.innerHTML = '';
});

function mount() {
  document.body.innerHTML = `<div data-reticle-chat-panel>${AGENT_LINK_HTML}</div>`;
  const root = document.querySelector<HTMLElement>('[data-reticle-chat-panel]');
  if (null === root) throw new Error('no panel');
  const onNote = vi.fn();
  const view = new AgentLinkView(onNote);
  view.mount(root, new AbortController().signal);
  return { root, view, onNote };
}

const text = (root: HTMLElement, sel: string): string =>
  root.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('the coding agent, from the HUD', () => {
  it('shows nothing for a daemon too old to say', () => {
    const { root, view } = mount();
    view.paint(undefined);
    expect(root.querySelector<HTMLElement>('[data-reticle-agent-spot]')?.hidden).toBe(true);
  });

  it('labels the note box with the connected agent, by name', () => {
    const { root, view } = mount();
    view.paint({ agents: ['Claude Code'], notes: [] });
    const input = root.querySelector<HTMLInputElement>('[data-reticle-agent-note]');
    expect(input?.placeholder).toBe('Note to Claude Code…');
    expect(root.querySelector(`label[for="${input?.id ?? ''}"]`)?.textContent).toBe(
      'Note to Claude Code',
    );
    expect(root.querySelector<HTMLElement>('[data-reticle-agent-none]')?.hidden).toBe(true);
    expect(agentsLine(['Claude Code'])).toBe('Connected: Claude Code');
  });

  it('with no agent, says so and offers the prompt instead of a box nobody reads', () => {
    const { root, view } = mount();
    view.paint({ agents: [], notes: [] });
    expect(text(root, '[data-reticle-agent-none]')).toContain('No coding agent connected');
    expect(root.querySelector('[data-reticle-agent-copy]')?.getAttribute('aria-label')).toBe(
      'Copy prompt for your coding agent',
    );
    expect(root.querySelector<HTMLElement>('[data-reticle-agent-form]')?.hidden).toBe(true);
  });

  it('sends the trimmed note on Send or Enter, and clears the box', () => {
    const { root, view, onNote } = mount();
    view.paint({ agents: ['Codex'], notes: [] });
    const input = root.querySelector<HTMLInputElement>('[data-reticle-agent-note]');
    if (null === input) throw new Error('no box');
    input.value = '  also try an empty cart ';
    root.querySelector<HTMLElement>('[data-reticle-agent-send]')?.click();
    expect(onNote).toHaveBeenCalledWith('also try an empty cart');
    expect(input.value).toBe('');
    input.value = 'and the coupon';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onNote).toHaveBeenLastCalledWith('and the coupon');
    root.querySelector<HTMLElement>('[data-reticle-agent-send]')?.click();
    expect(onNote).toHaveBeenCalledTimes(2);
  });

  it('says "Sent" until the daemon reports an agent took the note, then "Seen by" that agent', () => {
    const { root, view } = mount();
    view.paint({ agents: ['Claude Code'], notes: [{ text: 'check the coupon', seen: false }] });
    expect(text(root, '[data-reticle-agent-status]')).toBe(
      'Sent. Claude Code sees this the next time it calls Reticle.',
    );
    view.paint({
      agents: ['Claude Code'],
      notes: [{ text: 'check the coupon', seen: true, by: 'Claude Code' }],
    });
    expect(text(root, '[data-reticle-agent-status]')).toBe('Seen by Claude Code');
  });

  it('never names one agent for a note when several are connected and none took it yet', () => {
    const { root, view } = mount();
    view.paint({ agents: ['Claude Code', 'Cursor'], notes: [{ text: 'x', seen: false }] });
    expect(text(root, '[data-reticle-agent-status]')).toBe(
      'Sent. Your coding agent sees this the next time it calls Reticle.',
    );
  });
});
