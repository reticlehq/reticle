import { LOG_CSS } from './presenter-log.js';
import { CONTROLS_CSS } from './presenter-controls.js';
import { SHELL_CSS } from './presenter-shell-styles.js';
import { SETTINGS_CSS } from './presenter-settings-styles.js';
import { HUD_CHROME_CSS, HUD_LOG_WELL_CSS } from './presenter-hud-chrome.js';
import { REPORT_CSS } from './presenter-report-styles.js';
/**
 * All presenter overlay CSS - glow border, synthetic cursor/ring/ripple, and the floating HUD shell.
 * Split across shell-styles + controls + log modules so each file stays under the size cap.
 */
/**
 * The presenter overlay's stacking layer. Exported because the annotator has to sit ABOVE it: the
 * overlay holds the page blocker, and anything below this number is covered by that shield - which
 * is what buried the annotate composer and made its Cancel/Add buttons unclickable.
 */
export const Z_OVERLAY = 2147483600;

export const PRESENTER_CSS = `
[data-reticle-overlay]{position:fixed;inset:0;pointer-events:none;z-index:${String(Z_OVERLAY)};}
/**
 * The session glow: the page itself says an agent is here, and BREATHES while it is working.
 *
 * A white 1px hairline with no animation replaced the accent-coloured, pulsing border, and the one
 * signal you could read without looking at the HUD - "something is driving my app right now" -
 * disappeared with it. The accent follows the HUD's own swatch (--reticle-mark-accent, set on the
 * overlay root), so glow, cursor and dock stay one colour.
 */
[data-reticle-glow]{position:fixed;inset:0;pointer-events:none;z-index:${String(Z_OVERLAY)};opacity:0;
  --reticle-glow:var(--reticle-state,var(--reticle-mark-accent,#6366f1));
  transition:opacity .25s ease;
  box-shadow:inset 0 0 0 2px color-mix(in srgb,var(--reticle-glow) 70%,transparent),
    inset 0 0 22px 4px color-mix(in srgb,var(--reticle-glow) 26%,transparent);}
[data-reticle-glow][data-on="1"]{opacity:1;animation:reticle-pulse 2.4s ease-in-out infinite;}
[data-reticle-glow][data-on="1"][data-busy="1"]{animation:reticle-shimmer 1.1s ease-in-out infinite;}
@keyframes reticle-pulse{
  0%,100%{box-shadow:inset 0 0 0 2px color-mix(in srgb,var(--reticle-glow) 60%,transparent),
    inset 0 0 18px 3px color-mix(in srgb,var(--reticle-glow) 18%,transparent)}
  50%{box-shadow:inset 0 0 0 2px color-mix(in srgb,var(--reticle-glow) 80%,transparent),
    inset 0 0 30px 6px color-mix(in srgb,var(--reticle-glow) 32%,transparent)}}
@keyframes reticle-shimmer{
  0%,100%{box-shadow:inset 0 0 0 3px color-mix(in srgb,var(--reticle-glow) 85%,transparent),
    inset 0 0 30px 7px color-mix(in srgb,var(--reticle-glow) 42%,transparent)}
  50%{box-shadow:inset 0 0 0 3px var(--reticle-glow),
    inset 0 0 46px 12px color-mix(in srgb,var(--reticle-glow) 58%,transparent)}}
[data-reticle-overlay][data-reticle-reduce-motion="1"] [data-reticle-glow][data-on="1"]{animation:none;}
/* The page glow is the one signal that paints over the USER's app, so it is theirs to switch off.
   Every other signal - dot, panel, capsule, FAB halo - stays. */
[data-reticle-overlay][data-reticle-ambient-glow="0"] [data-reticle-glow]{display:none;}
[data-reticle-cursor]{position:fixed;top:0;left:0;width:20px;height:20px;margin:-10px 0 0 -10px;
  border:2px solid #fafafa;border-radius:50%;background:rgba(255,255,255,.12);pointer-events:none;
  z-index:2147483646;opacity:0;transition:transform .32s cubic-bezier(.22,1,.36,1),opacity .2s ease;}
[data-reticle-cursor][data-on="1"]{opacity:1;}
[data-reticle-cursor]::after{content:"";position:absolute;inset:6px;border-radius:50%;background:#fafafa;}
[data-reticle-ripple]{position:fixed;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;
  background:rgba(255,255,255,.35);pointer-events:none;z-index:2147483645;animation:reticle-ripple .45s ease-out forwards;}
@keyframes reticle-ripple{from{transform:scale(.5);opacity:.7}to{transform:scale(4);opacity:0}}
[data-reticle-ring]{position:fixed;pointer-events:none;z-index:2147483644;border:1px solid rgba(255,255,255,.55);border-radius:6px;
  box-shadow:none;opacity:0;transition:opacity .15s ease;}
[data-reticle-ring][data-on="1"]{opacity:1;}
[data-reticle-mode="reading"] [data-reticle-glow][data-on="1"]{box-shadow:inset 0 0 0 2px rgba(255,255,255,.22);}
[data-reticle-mode="reading"] [data-reticle-ring]{border-color:rgba(255,255,255,.7);box-shadow:none;}
[data-reticle-overlay][data-reticle-throttled="1"] [data-reticle-glow][data-on="1"]{
  box-shadow:inset 0 0 0 2px rgba(255,255,255,.18);}
[data-reticle-overlay] .reticle-hi-icon,
[data-reticle-overlay] .reticle-sl-icon{display:inline-flex;align-items:center;justify-content:center;line-height:1;flex-shrink:0;color:inherit;overflow:visible;}
[data-reticle-overlay] .reticle-hi-icon svg,
[data-reticle-overlay] .reticle-sl-icon svg{display:block;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;overflow:visible;}
${HUD_CHROME_CSS}
${HUD_LOG_WELL_CSS}
${SHELL_CSS}
${SETTINGS_CSS}
${REPORT_CSS}
${LOG_CSS}
${CONTROLS_CSS}`;
