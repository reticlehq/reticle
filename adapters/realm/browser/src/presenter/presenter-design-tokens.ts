/**
 * Reticle HUD design tokens, adapted from the Reticle platform's design system: near-black surfaces,
 * warm white text, saffron brand accent, a 4px spacing rhythm, and 6/10/14px radii. The HUD keeps
 * a compact type scale and a separate session-state accent because it must fit beside the app and
 * still communicate running/paused/ended at a glance.
 */
export const PRESENTER_DESIGN_TOKENS_CSS: string = `
[data-reticle-overlay]{
  --reticle-hud-space-0:0px;
  --reticle-hud-space-1:4px;
  --reticle-hud-space-2:8px;
  --reticle-hud-space-3:12px;
  --reticle-hud-space-4:16px;
  --reticle-hud-radius-sm:6px;
  --reticle-hud-radius-md:10px;
  --reticle-hud-radius-lg:14px;
  --reticle-hud-radius-pill:9999px;
  --reticle-hud-size-xs:11px;
  --reticle-hud-size-sm:12px;
  --reticle-hud-size-base:13px;
  --reticle-hud-icon-size:18px;
  --reticle-hud-control-size:36px;
  --reticle-hud-control-gap:4px;
  /* Compact: the HUD sits over the user's own app. 400×560 covered too much of it. */
  --reticle-hud-dock-width:320px;
  --reticle-hud-panel-height:440px;
  --reticle-hud-ground:#0b0b0c;
  --reticle-hud-surface:#151417;
  --reticle-hud-inset:#232227;
  --reticle-hud-hover:#1e1d22;
  --reticle-hud-border:#29282d;
  --reticle-hud-border-strong:#3a3941;
  --reticle-hud-text:#f5f3ef;
  --reticle-hud-text-muted:#a6a29a;
  --reticle-hud-text-faint:#8b867d;
  --reticle-hud-brand:#f0872e;
  --reticle-hud-brand-soft:#2a1b0d;
  --reticle-hud-ease:cubic-bezier(.4,0,.2,1);
}
`;
