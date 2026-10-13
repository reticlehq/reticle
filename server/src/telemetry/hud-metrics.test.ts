import { describe, expect, it } from 'vitest';
import { HudPanel, HudPromptSurface, HudToggle, HudUseDataSchema, HudView } from '@reticlehq/core';
import { HUD_JOURNEY_MAX, HUD_VIEW_DEDUPE_MS, HudMetrics } from './hud-metrics.js';

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

describe('rail slide impressions', () => {
  it('counts each slide id shown, and refuses anything shaped like text', () => {
    const hud = new HudMetrics(() => 0);
    hud.record({ slide: 'harness-drive' });
    hud.record({ slide: 'harness-drive' });
    hud.record({ slide: 'notice-reorder' });
    expect(hud.summarize().hudSlides).toEqual({ 'harness-drive': 2, 'notice-reorder': 1 });
    hud.record({ slide: 'Buy now at evil.example' });
    expect(Object.keys(hud.summarize().hudSlides ?? {})).toEqual([
      'harness-drive',
      'notice-reorder',
    ]);
    hud.reset();
    expect(hud.summarize().hudSlides).toBeUndefined();
  });
});

describe('HUD time is per tab, and only while somebody can see it', () => {
  it('keeps two tabs apart: one tab changing view does not close the other', () => {
    const c = clock();
    const m = new HudMetrics(c.now);
    m.record({ view: HudView.EXPANDED, panel: HudPanel.CHAT }, 'a');
    m.record({ view: HudView.BUBBLE, panel: HudPanel.NONE }, 'b');
    c.advance(4_000);
    const s = m.summarize();
    expect(s.hudViewMs).toEqual({ expanded: 4_000, bubble: 4_000 });
    expect(s.hudPanelMs).toEqual({ chat: 4_000, none: 4_000 });
  });

  it('stops the clock while the tab is hidden, and restarts it when it is shown', () => {
    const c = clock();
    const m = new HudMetrics(c.now);
    m.record({ view: HudView.EXPANDED, panel: HudPanel.FLOWS }, 'a');
    c.advance(1_000);
    m.hide('a');
    c.advance(60_000);
    m.show('a');
    c.advance(2_000);
    expect(m.summarize().hudPanelMs).toEqual({ flows: 3_000 });
  });

  it('stops the clock for good when the tab goes away', () => {
    const c = clock();
    const m = new HudMetrics(c.now);
    m.record({ view: HudView.EXPANDED, panel: HudPanel.CHAT }, 'a');
    c.advance(1_000);
    m.close('a');
    c.advance(3_600_000);
    expect(m.summarize().hudViewMs).toEqual({ expanded: 1_000 });
  });
});

describe('HUD page views and prompts, for their own events', () => {
  it('says a page was viewed, once per page per tab within the dedupe window', () => {
    const c = clock();
    const m = new HudMetrics(c.now);
    expect(m.record({ view: HudView.EXPANDED, panel: HudPanel.HARNESS }, 'a').viewed).toBe(
      HudPanel.HARNESS,
    );
    m.record({ view: HudView.EXPANDED, panel: HudPanel.CHAT }, 'a');
    c.advance(HUD_VIEW_DEDUPE_MS - 1);
    expect(
      m.record({ view: HudView.EXPANDED, panel: HudPanel.HARNESS }, 'a').viewed,
    ).toBeUndefined();
    // Another tab is another view.
    expect(m.record({ view: HudView.EXPANDED, panel: HudPanel.HARNESS }, 'b').viewed).toBe(
      HudPanel.HARNESS,
    );
    c.advance(1);
    m.record({ view: HudView.EXPANDED, panel: HudPanel.CHAT }, 'a');
    expect(m.record({ view: HudView.EXPANDED, panel: HudPanel.HARNESS }, 'a').viewed).toBe(
      HudPanel.HARNESS,
    );
  });

  it('never calls the closed HUD a page view', () => {
    const m = new HudMetrics(clock().now);
    expect(m.record({ view: HudView.BUBBLE, panel: HudPanel.NONE }, 'a').viewed).toBeUndefined();
  });

  it('counts the tabs with a HUD', () => {
    const m = new HudMetrics(clock().now);
    m.record({ view: HudView.BUBBLE, panel: HudPanel.NONE }, 'a');
    expect(m.record({ view: HudView.EXPANDED, panel: HudPanel.CHAT }, 'b').tabs).toBe(2);
    m.close('a');
    expect(m.record({ view: HudView.EXPANDED, panel: HudPanel.FLOWS }, 'b').tabs).toBe(1);
  });

  it('says a sign-in prompt was shown once per surface per tab', () => {
    const m = new HudMetrics(clock().now);
    expect(m.record({ prompt: HudPromptSurface.RAIL }, 'a').prompted).toBe(HudPromptSurface.RAIL);
    expect(m.record({ prompt: HudPromptSurface.RAIL }, 'a').prompted).toBeUndefined();
    expect(m.record({ prompt: HudPromptSurface.HEADER }, 'a').prompted).toBe(
      HudPromptSurface.HEADER,
    );
    expect(m.record({ prompt: HudPromptSurface.RAIL }, 'b').prompted).toBe(HudPromptSurface.RAIL);
  });
});
