import { describe, expect, it } from 'vitest';
import { HudPanel, HudToggle, HudUseDataSchema, HudView } from '@reticlehq/core';
import { HUD_JOURNEY_MAX, HudMetrics } from './hud-metrics.js';

function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe('HUD use, rolled into the session summary', () => {
  it('counts presses per control, and a toggle under the state it was switched to', () => {
    const m = new HudMetrics(clock().now);
    m.record({ control: 'pause' });
    m.record({ control: 'pause' });
    m.record({ control: 'setting.reduceMotion', toggle: HudToggle.ON });
    expect(m.summarize().hudControls).toEqual({ pause: 2, 'setting.reduceMotion:on': 1 });
  });

  it('times each view and panel, including the one still open', () => {
    const c = clock();
    const m = new HudMetrics(c.now);
    m.record({ view: HudView.BUBBLE, panel: HudPanel.NONE });
    c.advance(5_000);
    m.record({ view: HudView.EXPANDED, panel: HudPanel.CHAT });
    c.advance(2_000);
    const s = m.summarize();
    expect(s.hudViewMs).toEqual({ bubble: 5_000, expanded: 2_000 });
    expect(s.hudPanelMs).toEqual({ none: 5_000, chat: 2_000 });
  });

  it('keeps the journey in order, and says when it was cut', () => {
    const m = new HudMetrics(clock().now);
    m.record({ view: HudView.EXPANDED, panel: HudPanel.CHAT });
    m.record({ control: 'settings-btn' });
    expect(m.summarize().hudJourney).toEqual(['view:expanded', 'panel:chat', 'settings-btn']);
    for (let i = 0; i < HUD_JOURNEY_MAX; i++) m.record({ control: 'pause' });
    expect(m.summarize().hudJourney).toHaveLength(HUD_JOURNEY_MAX);
    expect(m.summarize().hudJourneyCut).toBe(true);
  });

  it('starts a new window on reset, with the open view timed from then', () => {
    const c = clock();
    const m = new HudMetrics(c.now);
    m.record({ view: HudView.COLLAPSED, control: 'chat-min' });
    c.advance(3_000);
    m.reset();
    c.advance(1_000);
    expect(m.summarize()).toEqual({ hudViewMs: { collapsed: 1_000 } });
  });

  it('drops a control the HUD never rendered, so free text cannot ride in', () => {
    expect(HudUseDataSchema.safeParse({ control: 'somebody@example.com' }).success).toBe(false);
    const m = new HudMetrics(clock().now);
    m.record({ control: 'my-secret-flow-name' });
    expect(m.empty).toBe(true);
    m.record({ control: 'link.docs' });
    expect(m.summarize().hudControls).toEqual({ 'link.docs': 1 });
  });

  it('is empty in a window where nobody touched it, however long it sat open', () => {
    const c = clock();
    const m = new HudMetrics(c.now);
    m.record({ view: HudView.EXPANDED });
    expect(m.empty).toBe(false);
    m.reset();
    c.advance(60_000);
    expect(m.empty).toBe(true);
  });
});
