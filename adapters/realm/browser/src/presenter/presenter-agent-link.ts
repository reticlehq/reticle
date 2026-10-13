/**
 * The coding agent, from the HUD: one line with a status dot. Connected, it names the agent; not
 * connected, it says so and offers the prompt to paste into one. The HUD sends the agent nothing
 * itself: the person talks to their agent in the agent's own window.
 */
import { type AgentLink } from '@reticlehq/core';
import { REPORT_TEXT } from './chrome/presenter-report-copy.js';

const COPIED_FLASH_MS = 1600;

const TEXT = {
  NONE: 'No coding agent connected',
  named: (names: string): string => `${names} connected`,
  COPY: 'Copy prompt',
  prompt: (url: string): string =>
    `Use Reticle to check ${url} in my running app, then tell me the verdict.`,
} as const;

export const AGENT_LINK_HTML = `<div data-reticle-agent-spot class="reticle-agent-spot" hidden>
  <div class="reticle-agent-row"><span data-reticle-agent-dot class="reticle-agent-dot" aria-hidden="true"></span><span data-reticle-agent-said class="reticle-agent-said">${TEXT.NONE}</span><button type="button" data-reticle-agent-copy class="reticle-agent-copy" aria-label="${REPORT_TEXT.COPY_PROMPT}" title="${REPORT_TEXT.COPY_PROMPT}">${TEXT.COPY}</button></div>
</div>`;

export const AGENT_LINK_CSS = `
[data-reticle-chat-panel] .reticle-agent-spot{flex:none;display:flex;flex-direction:column;gap:3px;}
[data-reticle-chat-panel] .reticle-agent-spot[hidden]{display:none;}
[data-reticle-chat-panel] .reticle-agent-row{display:flex;align-items:center;gap:8px;min-width:0;min-height:30px;padding:0 var(--reticle-hud-space-2);}
[data-reticle-chat-panel] .reticle-agent-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--reticle-hud-text-faint);}
[data-reticle-chat-panel] .reticle-agent-row[data-connected="1"] .reticle-agent-dot{background:#4ade80;box-shadow:0 0 0 3px rgba(74,222,128,.15);}
[data-reticle-chat-panel] .reticle-agent-said{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--reticle-hud-size-sm);color:var(--reticle-hud-text-muted);}
[data-reticle-chat-panel] .reticle-agent-copy:focus-visible{outline:2px solid var(--reticle-hud-brand);outline-offset:0;}
[data-reticle-chat-panel] .reticle-agent-copy{flex:none;height:22px;padding:0 9px;border:1px solid var(--reticle-hud-border-strong);border-radius:11px;background:transparent;color:var(--reticle-hud-text);font:inherit;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;}
[data-reticle-chat-panel] .reticle-agent-copy:hover{border-color:var(--reticle-hud-brand);color:var(--reticle-hud-brand);}
[data-reticle-chat-panel] .reticle-agent-copy[hidden]{display:none;}
`;

export class AgentLinkView {
  #root: HTMLElement | undefined;

  mount(root: HTMLElement, signal: AbortSignal): void {
    this.#root = root;
    root.querySelector('[data-reticle-agent-copy]')?.addEventListener(
      'click',
      (event) => {
        const button = event.currentTarget;
        void navigator.clipboard
          ?.writeText(TEXT.prompt(location.href))
          .catch(() => undefined)
          .finally(() => {
            if (!(button instanceof HTMLElement)) return;
            button.textContent = REPORT_TEXT.COPIED;
            window.setTimeout(
              () => (button.textContent = REPORT_TEXT.COPY_PROMPT),
              COPIED_FLASH_MS,
            );
          });
      },
      { signal },
    );
  }

  teardown(): void {
    this.#root = undefined;
  }

  /** Connected names the agent; not connected offers the prompt. An older daemon: nothing shown. */
  paint(link: AgentLink | undefined): void {
    const root = this.#root;
    const spot = root?.querySelector<HTMLElement>('[data-reticle-agent-spot]');
    if (root === undefined || null === spot || spot === undefined) return;
    spot.hidden = link === undefined;
    if (link === undefined) return;
    const connected = 0 < link.agents.length;
    spot.querySelector('.reticle-agent-row')?.setAttribute('data-connected', connected ? '1' : '0');
    const said = spot.querySelector<HTMLElement>('[data-reticle-agent-said]');
    if (said !== null)
      said.textContent = connected ? TEXT.named(link.agents.join(', ')) : TEXT.NONE;
    const copy = spot.querySelector<HTMLElement>('[data-reticle-agent-copy]');
    if (copy !== null) copy.hidden = connected;
  }
}
