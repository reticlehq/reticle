import { isHudControl } from '@reticlehq/core/hud';
import { HudPanel, HudView, type HudUseData } from '@reticlehq/core';

/**
 * How people use the in-page HUD, rolled into the session summary.
 *
 * Windowed like the tool histograms beside it: a periodic flush reports what happened since the
 * last one, so a dashboard sums across a session's events. Names only — every key is a control id
 * the wire schema already checked against core's closed list.
 */

/** How many steps of the journey one window keeps. A journey longer than this is cut, and says so. */
export const HUD_JOURNEY_MAX = 60;

export interface HudSummary {
  /** Presses per control; a toggle counts under `id:on` / `id:off` so a switch reads both ways. */
  hudControls?: Record<string, number>;
  /** Milliseconds the HUD spent in each view during the window. */
  hudViewMs?: Partial<Record<HudView, number>>;
  /** Milliseconds each panel was showing during the window. */
  hudPanelMs?: Partial<Record<HudPanel, number>>;
  /** The window's presses and view changes, in order, cut at HUD_JOURNEY_MAX. */
  hudJourney?: string[];
  /** Present, and true, only when the journey was cut. */
  hudJourneyCut?: true;
}

export class HudMetrics {
  readonly #now: () => number;
  readonly #controls = new Map<string, number>();
  readonly #viewMs = new Map<HudView, number>();
  readonly #panelMs = new Map<HudPanel, number>();
  readonly #journey: string[] = [];
  #cut = false;
  /** Did anything happen this window. A HUD merely sitting open is not worth a flush of its own. */
  #changed = false;
  #view: { value: HudView; since: number } | undefined;
  #panel: { value: HudPanel; since: number } | undefined;

  constructor(now: () => number) {
    this.#now = now;
  }

  record(use: HudUseData): void {
    // A control the HUD never rendered is dropped here, the one place HUD use is counted, so free
    // text cannot ride in on the id.
    const control =
      use.control !== undefined && isHudControl(use.control) ? use.control : undefined;
    if (control === undefined && use.view === undefined && use.panel === undefined) return;
    this.#changed = true;
    if (control !== undefined) {
      const key = use.toggle === undefined ? control : `${control}:${use.toggle}`;
      this.#controls.set(key, (this.#controls.get(key) ?? 0) + 1);
      this.#step(key);
    }
    if (use.view !== undefined && use.view !== this.#view?.value) {
      this.#close(this.#view, this.#viewMs);
      this.#view = { value: use.view, since: this.#now() };
      this.#step(`view:${use.view}`);
    }
    if (use.panel !== undefined && use.panel !== this.#panel?.value) {
      this.#close(this.#panel, this.#panelMs);
      this.#panel = { value: use.panel, since: this.#now() };
      if (use.panel !== HudPanel.NONE) this.#step(`panel:${use.panel}`);
    }
  }

  get empty(): boolean {
    return !this.#changed;
  }

  /** The window so far. Open view and panel are counted up to now, and keep running after. */
  summarize(): HudSummary {
    const viewMs = this.#withOpen(this.#view, this.#viewMs);
    const panelMs = this.#withOpen(this.#panel, this.#panelMs);
    return {
      ...(this.#controls.size > 0 ? { hudControls: Object.fromEntries(this.#controls) } : {}),
      ...(viewMs.size > 0 ? { hudViewMs: Object.fromEntries(viewMs) } : {}),
      ...(panelMs.size > 0 ? { hudPanelMs: Object.fromEntries(panelMs) } : {}),
      ...(this.#journey.length > 0 ? { hudJourney: [...this.#journey] } : {}),
      ...(this.#cut ? { hudJourneyCut: true as const } : {}),
    };
  }

  /** Start the next window. The current view and panel carry over, timed from now. */
  reset(): void {
    const at = this.#now();
    this.#controls.clear();
    this.#viewMs.clear();
    this.#panelMs.clear();
    this.#journey.length = 0;
    this.#cut = false;
    this.#changed = false;
    if (this.#view !== undefined) this.#view = { ...this.#view, since: at };
    if (this.#panel !== undefined) this.#panel = { ...this.#panel, since: at };
  }

  #step(entry: string): void {
    if (this.#journey.length < HUD_JOURNEY_MAX) this.#journey.push(entry);
    else this.#cut = true;
  }

  #close<K>(open: { value: K; since: number } | undefined, into: Map<K, number>): void {
    if (open === undefined) return;
    into.set(open.value, (into.get(open.value) ?? 0) + Math.max(0, this.#now() - open.since));
  }

  #withOpen<K>(
    open: { value: K; since: number } | undefined,
    closed: Map<K, number>,
  ): Map<K, number> {
    const out = new Map(closed);
    this.#close(open, out);
    return out;
  }
}
