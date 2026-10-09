/**
 * The coding agent, from the HUD: which one is connected, and a note to it.
 *
 * The note box once lived here as a "composer" and went, because nothing said whether it talked to
 * the HUD or the agent. This one names the agent on the box itself and says exactly what happens:
 * the note waits until the agent's next Reticle call, and it is marked seen only when a call took it.
 * Every word about delivery comes from the daemon's push, never from the click.
 */
import { AGENT_NOTE_MAX, type AgentLink } from '@reticlehq/core';
import { REPORT_TEXT } from './chrome/presenter-report-copy.js';

const NOTE_ID = 'reticle-agent-note';
const COPIED_FLASH_MS = 1600;

const capitalised = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

const TEXT = {
  NONE: 'No coding agent connected',
  SOMEONE: 'your coding agent',
  connected: (names: string): string => `Connected: ${names}`,
  noteTo: (agent: string): string => `Note to ${agent}`,
  placeholder: (agent: string): string => `Note to ${agent}…`,
  COPY: 'Copy prompt',
  SEND: 'Send',
  sent: (agent: string): string =>
    `Sent. ${capitalised(agent)} sees this the next time it calls Reticle.`,
  seen: (agent: string): string => `Seen by ${agent}`,
  prompt: (url: string): string =>
    `Use Reticle to check ${url} in my running app, then tell me the verdict.`,
} as const;

export const AGENT_LINK_HTML = `<div data-reticle-agent-spot class="reticle-agent-spot" hidden>
  <div data-reticle-agent-none class="reticle-agent-row" hidden><span class="reticle-agent-said">${TEXT.NONE}</span><button type="button" data-reticle-agent-copy class="reticle-agent-copy" aria-label="${REPORT_TEXT.COPY_PROMPT}" title="${REPORT_TEXT.COPY_PROMPT}">${TEXT.COPY}</button></div>
  <div data-reticle-agent-form class="reticle-agent-row" hidden>
    <label for="${NOTE_ID}" data-reticle-agent-label class="reticle-sr"></label>
    <input type="text" id="${NOTE_ID}" data-reticle-agent-note class="reticle-agent-note" maxlength="${String(AGENT_NOTE_MAX)}" autocomplete="off"><button type="button" data-reticle-agent-send class="reticle-agent-send">${TEXT.SEND}</button>
  </div>
  <p data-reticle-agent-status class="reticle-agent-status" aria-live="polite"></p>
</div>`;

export const AGENT_LINK_CSS = `
[data-reticle-chat-panel] .reticle-agent-spot{flex:none;display:flex;flex-direction:column;gap:3px;}
[data-reticle-chat-panel] .reticle-agent-spot[hidden],[data-reticle-chat-panel] .reticle-agent-spot [hidden]{display:none;}
[data-reticle-chat-panel] .reticle-agent-row{display:flex;align-items:center;gap:6px;min-width:0;min-height:30px;}
[data-reticle-chat-panel] .reticle-agent-said{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--reticle-hud-size-sm);color:var(--reticle-hud-text-muted);}
[data-reticle-chat-panel] .reticle-agent-note{box-sizing:border-box;flex:1;min-width:0;height:30px;font:inherit;font-size:var(--reticle-hud-size-sm);color:var(--reticle-hud-text);background:var(--reticle-hud-ground);border:1px solid var(--reticle-hud-border-strong);border-radius:var(--reticle-hud-radius-sm);padding:0 var(--reticle-hud-space-2);}
[data-reticle-chat-panel] .reticle-agent-note::placeholder{color:var(--reticle-hud-text-faint);}
[data-reticle-chat-panel] :is(.reticle-agent-note,.reticle-agent-send,.reticle-agent-copy):focus-visible{outline:2px solid var(--reticle-hud-brand);outline-offset:0;}
[data-reticle-chat-panel] .reticle-agent-send{flex:none;height:30px;padding:0 10px;border:1px solid var(--reticle-hud-border-strong);border-radius:var(--reticle-hud-radius-sm);background:transparent;color:var(--reticle-hud-text);font:inherit;font-size:var(--reticle-hud-size-sm);font-weight:600;cursor:pointer;}
[data-reticle-chat-panel] .reticle-agent-copy{flex:none;border:0;padding:0;background:none;color:var(--reticle-hud-brand);font:inherit;font-size:var(--reticle-hud-size-sm);font-weight:600;cursor:pointer;white-space:nowrap;}
[data-reticle-chat-panel] .reticle-agent-status{margin:0;font-size:11px;line-height:1.3;color:var(--reticle-hud-text-muted);}
[data-reticle-chat-panel] .reticle-agent-status:empty{display:none;}
[data-reticle-chat-panel] .reticle-agent-status[data-seen="1"]{color:var(--reticle-hud-brand);}
`;

/** "Connected: Claude Code", for the panel's foot line. */
export function agentsLine(agents: readonly string[]): string {
  return TEXT.connected(agents.join(', '));
}

/** Several agents connected and none named: the sentence still has to be true. */
function nameFor(agents: readonly string[], by?: string): string {
  if (by !== undefined) return by;
  return 1 === agents.length ? (agents[0] ?? TEXT.SOMEONE) : TEXT.SOMEONE;
}

export class AgentLinkView {
  #root: HTMLElement | undefined;
  #onNote: (text: string) => void;

  constructor(onNote: (text: string) => void) {
    this.#onNote = onNote;
  }

  mount(root: HTMLElement, signal: AbortSignal): void {
    this.#root = root;
    const input = root.querySelector<HTMLInputElement>('[data-reticle-agent-note]');
    const send = (): void => {
      const text = input?.value.trim() ?? '';
      if (null === input || 0 === text.length) return;
      this.#onNote(text);
      input.value = '';
    };
    root.querySelector('[data-reticle-agent-send]')?.addEventListener('click', send, { signal });
    input?.addEventListener(
      'keydown',
      (event) => {
        if ('Enter' !== event.key) return;
        event.preventDefault();
        send();
      },
      { signal },
    );
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

  /** Absent from an older daemon: nothing shown rather than a guess. */
  paint(link: AgentLink | undefined): void {
    const root = this.#root;
    const spot = root?.querySelector<HTMLElement>('[data-reticle-agent-spot]');
    if (root === undefined || null === spot || spot === undefined) return;
    spot.hidden = link === undefined;
    if (link === undefined) return;
    const connected = 0 < link.agents.length;
    const none = root.querySelector<HTMLElement>('[data-reticle-agent-none]');
    if (none !== null) none.hidden = connected;
    const form = root.querySelector<HTMLElement>('[data-reticle-agent-form]');
    if (form !== null) form.hidden = !connected;
    const name = nameFor(link.agents);
    const label = root.querySelector<HTMLElement>('[data-reticle-agent-label]');
    if (label !== null) label.textContent = TEXT.noteTo(name);
    const input = root.querySelector<HTMLInputElement>('[data-reticle-agent-note]');
    if (input !== null) input.placeholder = TEXT.placeholder(capitalised(name));
    // Only the latest note's fate: one line, never a list that grows into the log's space.
    const status = root.querySelector<HTMLElement>('[data-reticle-agent-status]');
    if (null === status) return;
    const latest = link.notes.at(-1);
    if (latest === undefined) {
      status.textContent = '';
      return;
    }
    const who = nameFor(link.agents, latest.by);
    status.textContent = latest.seen ? TEXT.seen(who) : TEXT.sent(who);
    status.title = latest.text;
    status.setAttribute('data-seen', latest.seen ? '1' : '0');
  }
}
