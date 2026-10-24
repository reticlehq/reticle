import { afterEach, describe, expect, it } from 'vitest';
import { HudPanel, HudPromptSurface, HudView } from '@reticlehq/core';
import { CountBucket, TelemetryEventKind } from '@reticlehq/core/telemetry';
import type { TelemetryExtra } from './telemetry.js';
import { resetSessionMetrics } from './session-metrics.js';
import { reportHudUse } from './hud-events.js';

function recorder(): {
  sent: { kind: string; extra: TelemetryExtra | undefined }[];
  emit: (kind: TelemetryEventKind, extra?: TelemetryExtra) => Promise<boolean>;
} {
  const sent: { kind: string; extra: TelemetryExtra | undefined }[] = [];
  return {
    sent,
    emit: (kind, extra) => {
      sent.push({ kind, extra });
      return Promise.resolve(true);
    },
  };
}

afterEach(() => resetSessionMetrics());

describe('HUD events', () => {
  it('sends hud_viewed for a page, with how many tabs have a HUD', () => {
    const t = recorder();
    reportHudUse({ view: HudView.BUBBLE, panel: HudPanel.NONE }, 'tab-1', t);
    reportHudUse({ view: HudView.EXPANDED, panel: HudPanel.HARNESS }, 'tab-2', t);
    expect(t.sent).toEqual([
      {
        kind: TelemetryEventKind.HUD_VIEWED,
        extra: { hud: { view: HudPanel.HARNESS, tabs: CountBucket.TWO_THREE } },
      },
    ]);
  });

  it('sends one hud_viewed for a page reopened within the dedupe window', () => {
    const t = recorder();
    reportHudUse({ view: HudView.EXPANDED, panel: HudPanel.FLOWS }, 'tab-1', t);
    reportHudUse({ panel: HudPanel.CHAT }, 'tab-1', t);
    reportHudUse({ panel: HudPanel.FLOWS }, 'tab-1', t);
    expect(t.sent.filter((e) => e.extra?.hud?.view === HudPanel.FLOWS)).toHaveLength(1);
  });

  it('sends hud_signin_prompted once per surface per daemon', () => {
    const t = recorder();
    reportHudUse({ prompt: HudPromptSurface.RAIL }, 'tab-1', t);
    reportHudUse({ prompt: HudPromptSurface.RAIL }, 'tab-1', t);
    reportHudUse({ prompt: HudPromptSurface.RAIL }, 'tab-2', t);
    expect(t.sent).toEqual([
      {
        kind: TelemetryEventKind.HUD_SIGNIN_PROMPTED,
        extra: { hud: { surface: HudPromptSurface.RAIL, tabs: CountBucket.ONE } },
      },
    ]);
  });
});
