import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_LINK_HTML, AgentLinkView } from './presenter-agent-link.js';

afterEach(() => {
  document.body.innerHTML = '';
});

function mount() {
  document.body.innerHTML = `<div data-reticle-chat-panel>${AGENT_LINK_HTML}</div>`;
  const root = document.querySelector<HTMLElement>('[data-reticle-chat-panel]');
  if (null === root) throw new Error('no panel');
  const view = new AgentLinkView();
  view.mount(root, new AbortController().signal);
  return { root, view };
}

const spot = (root: HTMLElement): HTMLElement | null =>
  root.querySelector<HTMLElement>('[data-reticle-agent-spot]');

describe('the coding agent, from the HUD', () => {
  it('shows nothing for a daemon too old to say', () => {
    const { root, view } = mount();
    view.paint(undefined);
    expect(spot(root)?.hidden).toBe(true);
  });

  it('with no agent, says so with a grey dot and offers the prompt to paste into one', () => {
    const { root, view } = mount();
    view.paint({ agents: [], notes: [] });
    expect(spot(root)?.hidden).toBe(false);
    expect(root.querySelector('.reticle-agent-row')?.getAttribute('data-connected')).toBe('0');
    expect(root.querySelector('[data-reticle-agent-said]')?.textContent).toBe(
      'No coding agent connected',
    );
    const copy = root.querySelector<HTMLElement>('[data-reticle-agent-copy]');
    expect(copy?.hidden).toBe(false);
    expect(copy?.getAttribute('aria-label')).toBe('Copy prompt for your coding agent');
  });

  it('with an agent connected, names it beside a green dot and has nothing to type into', () => {
    const { root, view } = mount();
    view.paint({ agents: ['Claude Code'], notes: [] });
    expect(spot(root)?.hidden).toBe(false);
    expect(root.querySelector('.reticle-agent-row')?.getAttribute('data-connected')).toBe('1');
    expect(root.querySelector('[data-reticle-agent-said]')?.textContent).toBe(
      'Claude Code connected',
    );
    expect(root.querySelector<HTMLElement>('[data-reticle-agent-copy]')?.hidden).toBe(true);
    expect(root.querySelector('input')).toBeNull();
  });
});
