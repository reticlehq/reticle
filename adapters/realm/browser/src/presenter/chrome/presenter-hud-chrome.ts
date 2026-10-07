/** Shared polished-black surfaces used across HUD chrome panels. */

export const HUD_SURFACE_CLASS = 'reticle-hud-surface';

/** Layered near-black base — no embedded image assets. */
export const HUD_SURFACE_FILL: string = `linear-gradient(165deg,#121218 0%,#09090c 42%,#000 100%)`;

export const HUD_SURFACE_PAINT: string = `background:${HUD_SURFACE_FILL};box-shadow:inset 0 1px 0 rgba(255,255,255,.09),0 0 0 1px rgba(255,255,255,.09);`;

export const HUD_DROP_SHADOW: string =
  '0 16px 40px rgba(0,0,0,.58),0 0 0 1px rgba(255,255,255,.08)';

/**
 * The HUD's pages: navy glass, lit from the top by the live-state blue, with that blue glowing BEHIND
 * the card. The look the HUD had before it went flat near-black, restored on purpose.
 *
 * The fill is opaque. At 96% the app's text still showed through the log on a white page, and on a
 * dark fill the eye reads a few percent of bleed as clutter. The glass is the tint and the glow; no
 * backdrop-filter, which was measured as the most expensive thing in the SDK.
 */
export const HUD_GLASS_PAINT: string = [
  'background:radial-gradient(130% 80% at 50% 0%,color-mix(in srgb,var(--reticle-c-active) 20%,transparent),transparent 62%),',
  'linear-gradient(180deg,#121a2e,#080b14);',
  'border:1px solid color-mix(in srgb,var(--reticle-c-active) 30%,rgba(255,255,255,.1));',
  `box-shadow:${HUD_DROP_SHADOW},0 0 64px -12px color-mix(in srgb,var(--reticle-c-active) 75%,transparent);`,
].join('');

export const HUD_CHROME_CSS = `
.${HUD_SURFACE_CLASS}{
  position:relative;overflow:hidden;
  contain:layout style paint;
  ${HUD_SURFACE_PAINT}
}
.${HUD_SURFACE_CLASS}::before,
[data-reticle-hud] .reticle-hud-deco::after{
  content:"";position:absolute;inset:0;pointer-events:none;border-radius:inherit;z-index:1;
  background:
    radial-gradient(ellipse 120% 70% at 50% -18%,rgba(255,255,255,.07),transparent 52%),
    linear-gradient(180deg,rgba(255,255,255,.035) 0%,transparent 36%,rgba(0,0,0,.12) 100%);
}
.${HUD_SURFACE_CLASS} > *{position:relative;z-index:2;}`;

/** Inset well for the activity log — sits inside the chat card. */
export const HUD_LOG_WELL_CLASS = 'reticle-hud-log-well';

/**
 * The activity feed sits ON the panel, not in a black box cut out of it.
 *
 * The inset well was a second surface inside a surface - two borders, two backgrounds - and it made
 * the panel read as a container rather than as one card. It also grew and shrank with its content,
 * so the panel resized on every row; the height is fixed now and the feed scrolls inside it.
 */
export const HUD_LOG_WELL_CSS: string = `
.${HUD_LOG_WELL_CLASS}{
  /* A settled height, but still allowed to shrink: pinned with flex:none it pushed the composer
     off the bottom of the panel the moment the rest of the content grew. */
  /* A flex column, so the feed inside actually FILLS the height: as a plain block the log was only
     as tall as its rows, which left the empty-state line floating near the top of an otherwise
     empty panel instead of centred in it. */
  position:relative;display:flex;flex-direction:column;
  flex:1 1 auto;height:240px;min-height:120px;max-height:300px;overflow:hidden;
  contain:layout style paint;
  margin:0 6px;border-radius:12px;background:transparent;}
.${HUD_LOG_WELL_CLASS} > *{position:relative;z-index:1;}`;
