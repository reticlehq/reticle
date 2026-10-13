import { isHudControl } from '@reticlehq/core/hud';
import { HudPanel, HudView, type HudPromptSurface, type HudUseData } from '@reticlehq/core';

/**
 * How people use the in-page HUD, rolled into the session summary.
 *
 * Windowed like the tool histograms beside it: a periodic flush reports what happened since the
 * last one, so a dashboard sums across a session's events. Names only — every key is a control id
 * the wire schema already checked against core's closed list.
 *
 * Time is kept PER TAB and only while the tab is visible. Two tabs used to share one open view, so
 * one tab's change closed the other's clock, and a hidden or closed tab kept accruing for as long as
 * the daemon lived.
 */

/** How many steps of the journey one window keeps. A journey longer than this is cut, and says so. */
export const HUD_JOURNEY_MAX = 60;

export interface HudSummary {
  /** Presses per control; a toggle counts under `id:on` / `id:off` so a switch reads both ways. */
  hudControls?: Record<string, number>;
  /** Milliseconds the HUD spent in each view during the window, summed over visible tabs. */
  hudViewMs?: Partial<Record<HudView, number>>;
  /** Milliseconds each panel was showing during the window, summed over visible tabs. */
  hudPanelMs?: Partial<Record<HudPanel, number>>;
  /** The window's presses and view changes, in order, cut at HUD_JOURNEY_MAX. */
  hudJourney?: string[];
  /** Present, and true, only when the journey was cut. */
  hudJourneyCut?: true;
  /** Times each rail slide became the visible one. Slide ids are Reticle's own, never page text. */
  hudSlides?: Record<string, number>;
}

/** Distinct slide ids counted per window; past this a broken notices file is not a dashboard. */
const MAX_SLIDE_IDS = 20;
const SLIDE_ID = /^[a-z0-9-]{1,56}$/;

/** The same page opened again on the same tab within this long is one view, not two. */
export const HUD_VIEW_DEDUPE_MS = 30_000;

/** A tab whose page reported HUD use without saying which tab: an older caller, or a test. */
const UNNAMED_TAB = '';

/** What a view or panel is, and since when it has been accruing; no `since` while nobody can see it. */
interface Open<K> {
  value: K;
  since: number | undefined;
}

/** One tab's HUD. */
interface TabState {
  view: Open<HudView> | undefined;
  panel: Open<HudPanel> | undefined;
  hidden: boolean;
  /** When each page last counted as a view on this tab. Session-lifetime, like the prompts. */
  readonly viewedAt: Map<HudPanel, number>;
  readonly prompted: Set<HudPromptSurface>;
}

/** What one HUD use means for the per-event signals, beside what it adds to the summary. */
export interface HudSignals {
  /** A page this tab had not opened within the dedupe window. */
  viewed?: HudPanel;
  /** A sign-in prompt this tab had not shown before. */
  prompted?: HudPromptSurface;
  /** Tabs with a HUD right now. */
  tabs: number;
}

export class HudMetrics {
  readonly #now: () => number;
  readonly #controls = new Map<string, number>();
  readonly #viewMs = new Map<HudView, number>();
  readonly #panelMs = new Map<HudPanel, number>();
  readonly #journey: string[] = [];
  readonly #slides = new Map<string, number>();
  readonly #tabs = new Map<string, TabState>();
  #cut = false;
  /** Did anything happen this window. A HUD merely sitting open is not worth a flush of its own. */
  #changed = false;

  constructor(now: () => number) {
    this.#now = now;
  }

  record(use: HudUseData, tabId: string = UNNAMED_TAB): HudSignals {
    const tab = this.#tab(tabId);
    const signals: HudSignals = { tabs: this.#tabs.size };
    if (use.prompt !== undefined && !tab.prompted.has(use.prompt)) {
      tab.prompted.add(use.prompt);
      signals.prompted = use.prompt;
    }
    // A control the HUD never rendered is dropped here, the one place HUD use is counted, so free
    // text cannot ride in on the id.
    const control =
      use.control !== undefined && isHudControl(use.control) ? use.control : undefined;
    if (use.slide !== undefined) this.#countSlide(use.slide);
    if (control === undefined && use.view === undefined && use.panel === undefined) return signals;
    this.#changed = true;
    if (control !== undefined) {
      const key = use.toggle === undefined ? control : `${control}:${use.toggle}`;
      this.#controls.set(key, (this.#controls.get(key) ?? 0) + 1);
      this.#step(key);
    }
    const at = this.#now();
    const since = tab.hidden ? undefined : at;
    if (use.view !== undefined && use.view !== tab.view?.value) {
      this.#close(tab.view, this.#viewMs);
      tab.view = { value: use.view, since };
      this.#step(`view:${use.view}`);
    }
    if (use.panel !== undefined && use.panel !== tab.panel?.value) {
      this.#close(tab.panel, this.#panelMs);
      tab.panel = { value: use.panel, since };
      if (use.panel !== HudPanel.NONE) {
        this.#step(`panel:${use.panel}`);
        const last = tab.viewedAt.get(use.panel);
        if (last === undefined || at - last >= HUD_VIEW_DEDUPE_MS) {
          tab.viewedAt.set(use.panel, at);
          signals.viewed = use.panel;
        }
      }
    }
    return signals;
  }

  /** The tab went into the background: its HUD stops accruing time until it is shown again. */
  hide(tabId: string): void {
    const tab = this.#tabs.get(tabId);
    if (tab === undefined || tab.hidden) return;
    tab.hidden = true;
    this.#pause(tab);
  }

  /** The tab is in front again: its HUD's view and panel accrue from now. */
  show(tabId: string): void {
    const tab = this.#tabs.get(tabId);
    if (tab === undefined || !tab.hidden) return;
    tab.hidden = false;
    const at = this.#now();
    if (tab.view !== undefined) tab.view = { ...tab.view, since: at };
    if (tab.panel !== undefined) tab.panel = { ...tab.panel, since: at };
  }

  /** The tab went away: whatever it had open is counted up to now and stops. */
  close(tabId: string): void {
    const tab = this.#tabs.get(tabId);
    if (tab === undefined) return;
    this.#pause(tab);
    this.#tabs.delete(tabId);
  }

  #tab(tabId: string): TabState {
    const known = this.#tabs.get(tabId);
    if (known !== undefined) return known;
    const tab: TabState = {
      view: undefined,
      panel: undefined,
      hidden: false,
      viewedAt: new Map(),
      prompted: new Set(),
    };
    this.#tabs.set(tabId, tab);
    return tab;
  }

  #pause(tab: TabState): void {
    this.#close(tab.view, this.#viewMs);
    this.#close(tab.panel, this.#panelMs);
    if (tab.view !== undefined) tab.view = { ...tab.view, since: undefined };
    if (tab.panel !== undefined) tab.panel = { ...tab.panel, since: undefined };
  }

  #countSlide(slide: string): void {
    // A slide id is Reticle's own (`notice-<id>` for the remote ones): lowercase words and dashes.
    if (!SLIDE_ID.test(slide)) return;
    if (!this.#slides.has(slide) && this.#slides.size >= MAX_SLIDE_IDS) return;
    this.#slides.set(slide, (this.#slides.get(slide) ?? 0) + 1);
    this.#changed = true;
  }

  get empty(): boolean {
    return !this.#changed;
  }

  /** The window so far. Open views and panels are counted up to now, and keep running after. */
  summarize(): HudSummary {
    const viewMs = new Map(this.#viewMs);
    const panelMs = new Map(this.#panelMs);
    for (const tab of this.#tabs.values()) {
      this.#close(tab.view, viewMs);
      this.#close(tab.panel, panelMs);
    }
    return {
      ...(this.#controls.size > 0 ? { hudControls: Object.fromEntries(this.#controls) } : {}),
      ...(viewMs.size > 0 ? { hudViewMs: Object.fromEntries(viewMs) } : {}),
      ...(panelMs.size > 0 ? { hudPanelMs: Object.fromEntries(panelMs) } : {}),
      ...(this.#journey.length > 0 ? { hudJourney: [...this.#journey] } : {}),
      ...(this.#cut ? { hudJourneyCut: true as const } : {}),
      ...(this.#slides.size > 0 ? { hudSlides: Object.fromEntries(this.#slides) } : {}),
    };
  }

  /** Start the next window. Each visible tab's view and panel carry over, timed from now. */
  reset(): void {
    const at = this.#now();
    this.#controls.clear();
    this.#slides.clear();
    this.#viewMs.clear();
    this.#panelMs.clear();
    this.#journey.length = 0;
    this.#cut = false;
    this.#changed = false;
    for (const tab of this.#tabs.values()) {
      if (tab.view?.since !== undefined) tab.view = { ...tab.view, since: at };
      if (tab.panel?.since !== undefined) tab.panel = { ...tab.panel, since: at };
    }
  }

  #step(entry: string): void {
    if (this.#journey.length < HUD_JOURNEY_MAX) this.#journey.push(entry);
    else this.#cut = true;
  }

  /** Add an open view's time since it last started accruing; nothing while it is paused. */
  #close<K>(open: Open<K> | undefined, into: Map<K, number>): void {
    if (open?.since === undefined) return;
    into.set(open.value, (into.get(open.value) ?? 0) + Math.max(0, this.#now() - open.since));
  }
}
