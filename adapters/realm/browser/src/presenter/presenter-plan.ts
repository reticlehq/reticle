import { ScriptStatus, type PlanView } from '@reticlehq/core';

/**
 * The Harness's drive plan, drawn at the top of the Agent Log while it runs.
 *
 * Lanes are columns (they run side by side), journeys are cards in the order a lane drives them,
 * and the journey being driven opens to show its steps. Each push replaces the whole picture, so a
 * missed push costs one frame, never a wrong one.
 */
export const PLAN_ATTR = 'data-reticle-plan';
const CLOSE_ATTR = 'data-reticle-plan-close';
const JOURNEY_ATTR = 'data-reticle-plan-journey';
export const PLAN_HTML = `<div ${PLAN_ATTR} class="reticle-plan" hidden></div>`;

const TEXT = {
  TITLE: 'Harness plan',
  CLOSE: 'Hide the plan',
  WAITS: 'waits on',
  AT_ONCE: 'at once',
  LANE: 'Lane',
} as const;

const GLYPH: Record<ScriptStatus, string> = {
  [ScriptStatus.PENDING]: '○',
  [ScriptStatus.RUNNING]: '◐',
  [ScriptStatus.PASSED]: '✓',
  [ScriptStatus.FAILED]: '✗',
  [ScriptStatus.BLOCKED]: '⊘',
  [ScriptStatus.NOT_TAKEN]: '–',
};

export const PLAN_CSS: string = `
[data-reticle-chat-panel] .reticle-plan{flex:none;margin:0 10px 8px;padding:8px 10px;border:1px solid var(--reticle-hud-border);border-radius:10px;background:rgba(255,255,255,.03);}
[data-reticle-chat-panel] .reticle-plan[hidden]{display:none;}
[data-reticle-chat-panel] .reticle-plan-head{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:var(--reticle-hud-size-xs);color:var(--reticle-hud-text-muted);}
[data-reticle-chat-panel] .reticle-plan-head strong{color:var(--reticle-hud-text);font-size:var(--reticle-hud-size-sm);font-weight:600;}
[data-reticle-chat-panel] .reticle-plan-head span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-reticle-chat-panel] .reticle-plan-close{flex:none;border:0;background:none;color:inherit;cursor:pointer;font-size:14px;line-height:1;padding:2px 4px;}
[data-reticle-chat-panel] .reticle-plan-lanes{display:flex;flex-direction:column;gap:6px;max-height:240px;overflow:auto;scrollbar-width:none;}
[data-reticle-chat-panel] .reticle-plan-lanes::-webkit-scrollbar{display:none;}
[data-reticle-chat-panel] .reticle-plan-lane{display:flex;gap:6px;align-items:flex-start;min-width:0;}
[data-reticle-chat-panel] .reticle-plan-lane-name{flex:none;width:16px;padding-top:6px;font-size:10px;font-weight:600;text-align:center;color:var(--reticle-hud-text-muted);}
[data-reticle-chat-panel] .reticle-plan-lane-journeys{display:flex;flex:1;min-width:0;flex-direction:column;gap:4px;}
[data-reticle-chat-panel] .reticle-plan-journey{display:block;width:100%;text-align:left;border:1px solid transparent;border-radius:8px;padding:5px 7px;background:rgba(255,255,255,.04);color:var(--reticle-hud-text);font:inherit;font-size:var(--reticle-hud-size-xs);cursor:pointer;}
[data-reticle-chat-panel] .reticle-plan-journey[data-status="running"]{border-color:var(--reticle-c-active);box-shadow:0 0 12px -4px var(--reticle-c-active);}
[data-reticle-chat-panel] .reticle-plan-journey[data-status="blocked"],[data-reticle-chat-panel] .reticle-plan-journey[data-status="not-taken"]{opacity:.55;}
[data-reticle-chat-panel] .reticle-plan-row{display:flex;gap:6px;align-items:baseline;min-width:0;}
[data-reticle-chat-panel] .reticle-plan-row b{flex:1;min-width:0;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-reticle-chat-panel] .reticle-plan-glyph{flex:none;width:12px;text-align:center;}
[data-reticle-chat-panel] [data-status="running"]>.reticle-plan-row>.reticle-plan-glyph,[data-reticle-chat-panel] .reticle-plan-step[data-status="running"]>.reticle-plan-glyph{color:var(--reticle-c-active);animation:reticle-flow-pulse 1.2s ease-in-out infinite;}
[data-reticle-chat-panel] [data-status="passed"]>.reticle-plan-row>.reticle-plan-glyph,[data-reticle-chat-panel] .reticle-plan-step[data-status="passed"]>.reticle-plan-glyph{color:#4ade80;}
[data-reticle-chat-panel] [data-status="failed"]>.reticle-plan-row>.reticle-plan-glyph,[data-reticle-chat-panel] .reticle-plan-step[data-status="failed"]>.reticle-plan-glyph{color:#f87171;}
[data-reticle-chat-panel] .reticle-plan-meta{display:block;margin:2px 0 0 18px;color:var(--reticle-hud-text-muted);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-reticle-chat-panel] .reticle-plan-steps{margin:4px 0 0 18px;display:flex;flex-direction:column;gap:2px;}
[data-reticle-chat-panel] .reticle-plan-step{display:flex;gap:6px;color:var(--reticle-hud-text-muted);font-size:10px;min-width:0;}
[data-reticle-chat-panel] .reticle-plan-step span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
`;

const STATUSES = new Set<string>(Object.values(ScriptStatus));

function statusOf(value: unknown): ScriptStatus {
  return 'string' === typeof value && STATUSES.has(value)
    ? (value as ScriptStatus)
    : ScriptStatus.PENDING;
}

function textOf(value: unknown): string {
  return 'string' === typeof value ? value : '';
}

function listOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> => 'object' === typeof v && null !== v)
    : [];
}

/** A PLAN push, read defensively: the wire is the daemon's, and a bad frame draws nothing. */
export function parsePlanView(args: Record<string, unknown>): PlanView | undefined {
  const lanes = listOf(args['lanes']).map((lane) => ({
    id: textOf(lane['id']),
    journeys: listOf(lane['journeys']).map((j) => ({
      id: textOf(j['id']),
      title: textOf(j['title']),
      ...('string' === typeof j['persona'] ? { persona: j['persona'] } : {}),
      waitsOn: Array.isArray(j['waitsOn']) ? j['waitsOn'].map(textOf) : [],
      status: statusOf(j['status']),
      steps: listOf(j['steps']).map((s) => ({
        label: textOf(s['label']),
        status: statusOf(s['status']),
      })),
    })),
  }));
  if (0 === lanes.length) return undefined;
  const parallel = 'number' === typeof args['parallel'] ? args['parallel'] : 1;
  return { parallel, lanes };
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class PlanBoard {
  #host: HTMLElement | undefined;
  #view: PlanView | undefined;
  #dismissed = false;
  /** Journeys a person opened or closed by hand, so a repaint keeps their choice. */
  #toggled = new Map<string, boolean>();

  mount(root: HTMLElement): void {
    this.#host = root.querySelector<HTMLElement>(`[${PLAN_ATTR}]`) ?? undefined;
    this.#host?.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (null !== target.closest(`[${CLOSE_ATTR}]`)) {
        this.#dismissed = true;
        this.#paint();
        return;
      }
      const card = target.closest(`[${JOURNEY_ATTR}]`);
      const key = card?.getAttribute(JOURNEY_ATTR);
      if (null === key || key === undefined) return;
      this.#toggled.set(key, 'true' !== card?.getAttribute('aria-expanded'));
      this.#paint();
    });
    this.#paint();
  }

  paint(view: PlanView): void {
    // A plan where nothing has started yet is a new drive: show it again even if the last was hidden.
    const fresh = view.lanes.every((lane) =>
      lane.journeys.every((j) => ScriptStatus.PENDING === j.status),
    );
    if (fresh) {
      this.#dismissed = false;
      this.#toggled.clear();
    }
    this.#view = view;
    this.#paint();
  }

  #paint(): void {
    const host = this.#host;
    const view = this.#view;
    if (host === undefined) return;
    host.replaceChildren();
    host.hidden = view === undefined || this.#dismissed;
    if (view === undefined || this.#dismissed) return;

    const journeys = view.lanes.flatMap((lane) => lane.journeys);
    const done = journeys.filter((j) => ScriptStatus.PASSED === j.status).length;
    const head = el('div', 'reticle-plan-head');
    head.append(
      el('strong', '', TEXT.TITLE),
      el(
        'span',
        '',
        `${String(done)} of ${String(journeys.length)} passed · ${String(view.lanes.length)} lane(s)` +
          (1 < view.parallel ? `, ${String(view.parallel)} ${TEXT.AT_ONCE}` : ''),
      ),
    );
    const close = el('button', 'reticle-plan-close', '×');
    close.setAttribute('type', 'button');
    close.setAttribute(CLOSE_ATTR, '');
    close.setAttribute('aria-label', TEXT.CLOSE);
    close.setAttribute('title', TEXT.CLOSE);
    head.append(close);

    const lanes = el('div', 'reticle-plan-lanes');
    for (const lane of view.lanes) {
      // One row per lane: lanes run side by side, the journeys in a lane one after another.
      const row = el('div', 'reticle-plan-lane');
      const name = el('span', 'reticle-plan-lane-name', lane.id);
      name.setAttribute('title', `${TEXT.LANE} ${lane.id}`);
      const journeys = el('div', 'reticle-plan-lane-journeys');
      for (const journey of lane.journeys) journeys.append(this.#card(lane.id, journey));
      row.append(name, journeys);
      lanes.append(row);
    }
    host.append(head, lanes);
  }

  #card(laneId: string, journey: PlanView['lanes'][number]['journeys'][number]): HTMLElement {
    const key = `${laneId}/${journey.id}`;
    const open =
      this.#toggled.get(key) ??
      (ScriptStatus.RUNNING === journey.status || ScriptStatus.FAILED === journey.status);
    const card = el('button', 'reticle-plan-journey');
    card.setAttribute('type', 'button');
    card.setAttribute(JOURNEY_ATTR, key);
    card.setAttribute('data-status', journey.status);
    card.setAttribute('aria-expanded', String(open));
    const row = el('span', 'reticle-plan-row');
    row.append(el('span', 'reticle-plan-glyph', GLYPH[journey.status]), el('b', '', journey.title));
    card.append(row);
    const meta = [
      journey.persona,
      0 < journey.waitsOn.length ? `${TEXT.WAITS} ${journey.waitsOn.join(', ')}` : undefined,
    ].filter((part): part is string => part !== undefined && 0 < part.length);
    if (0 < meta.length) card.append(el('span', 'reticle-plan-meta', meta.join(' · ')));
    if (open && 0 < journey.steps.length) {
      const steps = el('span', 'reticle-plan-steps');
      for (const step of journey.steps) {
        const line = el('span', 'reticle-plan-step');
        line.setAttribute('data-status', step.status);
        line.append(
          el('span', 'reticle-plan-glyph', GLYPH[step.status]),
          el('span', '', step.label),
        );
        steps.append(line);
      }
      card.append(steps);
    }
    return card;
  }
}
