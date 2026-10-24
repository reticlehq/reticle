/**
 * The HUD's own events: `hud_viewed` when a page is opened, `hud_signin_prompted` when a sign-in or
 * link ask is shown. The windowed summary (`hudPanelMs`, `hudJourney`) says how long and in what
 * order; these say how often and by whom, which a window summed across a session cannot.
 *
 * Sent by the daemon, like every HUD measure, so every opt-out applies, and only from the names the
 * wire schema already narrowed. The dedupe (per daemon, per page or surface) lives in `HudMetrics`.
 */
import type { HudUseData } from '@reticlehq/core';
import { TelemetryEventKind, countBucket } from '@reticlehq/core/telemetry';
import { getSessionMetrics } from './session-metrics.js';
import { getTelemetry, type Telemetry } from './telemetry.js';

/** Count one HUD use from one tab, and send the events it amounts to. */
export function reportHudUse(
  use: HudUseData,
  tab: string,
  telemetry: Pick<Telemetry, 'emit'> = getTelemetry(),
): void {
  const signals = getSessionMetrics().recordHudUse(use, tab);
  const tabs = countBucket(signals.tabs);
  try {
    if (signals.viewed !== undefined)
      void telemetry.emit(TelemetryEventKind.HUD_VIEWED, { hud: { view: signals.viewed, tabs } });
    if (signals.prompted !== undefined)
      void telemetry.emit(TelemetryEventKind.HUD_SIGNIN_PROMPTED, {
        hud: { surface: signals.prompted, tabs },
      });
  } catch {
    /* a metric may never change behaviour */
  }
}

/** The tab went into the background or came back: its HUD time pauses while it is hidden. */
export function noteHudTabHidden(tab: string, hidden: boolean): void {
  getSessionMetrics().setHudTabHidden(tab, hidden);
}

/** The tab went away. */
export function noteHudTabClosed(tab: string): void {
  getSessionMetrics().closeHudTab(tab);
}
