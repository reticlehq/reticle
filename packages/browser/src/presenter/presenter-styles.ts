import { LOG_CSS } from './presenter-log.js';
import { CONTROLS_CSS } from './presenter-controls.js';

/**
 * All presenter overlay CSS — the glow border, synthetic cursor/ring/ripple, and the glassy HUD.
 * Split out of presenter.ts so that file stays a cohesive controller under the size cap; this is
 * pure style data (no behavior). LOG_CSS + CONTROLS_CSS are composed in at the end as before.
 */
export const PRESENTER_CSS = `
@import url("https://fonts.googleapis.com/css2?family=IBM+Plex+Serif:wght@400;500&family=Inter:wght@400;450;500;600&display=swap");
[data-iris-glow]{position:fixed;inset:0;pointer-events:none;z-index:2147483600;opacity:0;
  transition:opacity .25s ease;box-shadow:inset 0 0 0 3px rgba(99,102,241,.9),inset 0 0 28px 6px rgba(99,102,241,.45);}
[data-iris-glow][data-on="1"]{opacity:1;animation:iris-pulse 1.6s ease-in-out infinite;}
[data-iris-glow][data-on="1"][data-busy="1"]{animation:iris-shimmer 1.1s ease-in-out infinite;}
@keyframes iris-pulse{0%,100%{box-shadow:inset 0 0 0 3px rgba(99,102,241,.9),inset 0 0 22px 4px rgba(99,102,241,.35)}
  50%{box-shadow:inset 0 0 0 3px rgba(124,127,242,1),inset 0 0 40px 10px rgba(99,102,241,.6)}}
@keyframes iris-shimmer{0%,100%{box-shadow:inset 0 0 0 3px rgba(124,127,242,1),inset 0 0 34px 8px rgba(99,102,241,.55)}
  50%{box-shadow:inset 0 0 0 3px rgba(140,142,255,1),inset 0 0 48px 12px rgba(99,102,241,.7)}}
[data-iris-cursor]{position:fixed;top:0;left:0;width:22px;height:22px;margin:-11px 0 0 -11px;
  border:2px solid #6366f1;border-radius:50%;background:rgba(99,102,241,.25);pointer-events:none;
  z-index:2147483646;opacity:0;transition:transform .32s cubic-bezier(.22,1,.36,1),opacity .2s ease;}
[data-iris-cursor][data-on="1"]{opacity:1;}
[data-iris-cursor]::after{content:"";position:absolute;inset:7px;border-radius:50%;background:#6366f1;}
[data-iris-ripple]{position:fixed;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;
  background:rgba(99,102,241,.5);pointer-events:none;z-index:2147483645;animation:iris-ripple .5s ease-out forwards;}
@keyframes iris-ripple{from{transform:scale(.4);opacity:.8}to{transform:scale(5);opacity:0}}
[data-iris-ring]{position:fixed;pointer-events:none;z-index:2147483644;border:2px solid #22c55e;border-radius:8px;
  box-shadow:0 0 0 3px rgba(34,197,94,.25);opacity:0;transition:opacity .15s ease;}
[data-iris-ring][data-on="1"]{opacity:1;}
[data-iris-hud]{
  --iris-accent:#7c83ff;--iris-accent-soft:rgba(124,131,255,.16);
  --iris-bg:rgba(13,15,22,.80);--iris-bg2:rgba(19,22,32,.74);
  --iris-fg:#e9ebf2;--iris-muted:#9aa0b2;--iris-faint:#6a7186;
  --iris-line:rgba(255,255,255,.09);--iris-line2:rgba(255,255,255,.05);
  --iris-read:#54d2e6;--iris-ok:#3dd7a6;--iris-bad:#ff7a7a;
  --iris-font:"Inter",system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --iris-serif:"IBM Plex Serif",Georgia,"Times New Roman",serif;
  position:fixed;left:50%;right:auto;bottom:20px;box-sizing:border-box;
  width:384px;height:468px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);
  display:flex;flex-direction:column;overflow:hidden;text-align:left;z-index:2147483647;pointer-events:none;
  font-family:var(--iris-font);font-size:13px;line-height:1.5;color:var(--iris-fg);-webkit-font-smoothing:antialiased;
  background:linear-gradient(180deg,var(--iris-bg),var(--iris-bg2));
  -webkit-backdrop-filter:blur(24px) saturate(1.5);backdrop-filter:blur(24px) saturate(1.5);
  border:1px solid var(--iris-line);border-radius:20px;
  box-shadow:0 28px 70px -18px rgba(0,0,0,.66),0 0 0 1px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.07),0 0 54px -22px var(--iris-accent);
  opacity:0;transform:translateX(-50%) translateY(14px) scale(.985);
  transition:opacity .3s ease,transform .42s cubic-bezier(.16,1,.3,1),height .42s cubic-bezier(.16,1,.3,1),border-radius .42s ease,box-shadow .35s ease;}
[data-iris-overlay][data-iris-state="paused"] [data-iris-hud]{--iris-accent:#f6b44c;--iris-accent-soft:rgba(246,180,76,.16);}
[data-iris-overlay][data-iris-state="ended"] [data-iris-hud]{--iris-accent:#3dd7a6;--iris-accent-soft:rgba(61,215,166,.14);}
[data-iris-hud]::before{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;
  background:radial-gradient(130% 90% at 50% 0%,var(--iris-accent-soft),transparent 60%);}
[data-iris-hud]>*{position:relative;}
[data-iris-hud][data-on="1"]{opacity:1;transform:translateX(-50%) translateY(0) scale(1);}
/* Click-through: the glassy panel itself never blocks the app — only its interactive controls
   capture clicks (buttons / inputs), so a human can click straight through the HUD to the page.
   The log auto-scrolls, so it stays click-through too (drag-scroll is traded for click-through). */
[data-iris-hud] button,[data-iris-hud] input,[data-iris-hud] textarea,
[data-iris-hud] select,[data-iris-hud] [contenteditable]{pointer-events:auto;}
/* When minimised to a pill, the whole bar is the (single) click target to restore. */
[data-iris-overlay][data-iris-min="1"] [data-iris-hud][data-on="1"]{pointer-events:auto;}
[data-iris-hud] .iris-hud-head{display:flex;align-items:center;gap:8px;flex:none;
  padding:12px 12px 12px 15px;border-bottom:1px solid var(--iris-line2);}
[data-iris-hud] .iris-dot{width:9px;height:9px;border-radius:50%;flex:none;background:var(--iris-accent);
  animation:iris-breathe 2.6s ease-in-out infinite;}
@keyframes iris-breathe{0%,100%{box-shadow:0 0 0 0 var(--iris-accent),0 0 7px 1px var(--iris-accent);opacity:.85}
  50%{box-shadow:0 0 0 4px var(--iris-accent-soft),0 0 15px 3px var(--iris-accent);opacity:1}}
[data-iris-hud] .iris-brand{font-family:var(--iris-serif);font-weight:500;font-size:15px;letter-spacing:.01em;color:var(--iris-fg);}
[data-iris-hud] .iris-head-sp{flex:1;}
[data-iris-hud] .iris-live{display:none;flex:1;min-width:0;color:var(--iris-muted);font-size:12.5px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[data-iris-hud] .iris-maxhint{display:none;flex:none;color:var(--iris-faint);font-size:13px;line-height:1;}
[data-iris-hud] .iris-act-strip{flex:none;padding:7px 15px;border-bottom:1px solid var(--iris-line2);background:rgba(0,0,0,.14);}
[data-iris-hud] .iris-act{display:block;color:var(--iris-muted);font-size:11.5px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
[data-iris-hud] [data-iris-min-btn]{flex:none;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;
  width:26px;height:26px;border-radius:8px;border:1px solid var(--iris-line);background:rgba(255,255,255,.04);
  color:var(--iris-muted);font-size:15px;line-height:1;transition:background .15s,color .15s,transform .1s;}
[data-iris-hud] [data-iris-min-btn]:hover{color:var(--iris-fg);background:rgba(255,255,255,.08);}
[data-iris-hud] [data-iris-min-btn]:active{transform:scale(.94);}
[data-iris-hud] .iris-pass{color:var(--iris-ok);}[data-iris-hud] .iris-fail{color:var(--iris-bad);}
[data-iris-hud] .iris-chip{display:none;flex:none;font-size:9px;font-weight:600;letter-spacing:.08em;
  padding:2px 7px;border-radius:6px;vertical-align:middle;}
[data-iris-hud] .iris-chip[data-mode="reading"]{display:inline-block;color:var(--iris-read);
  background:rgba(84,210,230,.12);border:1px solid rgba(84,210,230,.32);}
[data-iris-hud] .iris-chip[data-mode="acting"]{display:inline-block;color:var(--iris-accent);
  background:var(--iris-accent-soft);border:1px solid var(--iris-accent);}
[data-iris-hud] .iris-chip[data-mode="idle"]{display:none;}
[data-iris-overlay][data-iris-min="1"] [data-iris-hud]{height:50px;border-radius:25px;cursor:pointer;}
[data-iris-overlay][data-iris-min="1"] [data-iris-hud] .iris-hud-head{border-bottom:none;height:50px;padding:0 12px 0 16px;}
[data-iris-overlay][data-iris-min="1"] [data-iris-hud] .iris-brand,
[data-iris-overlay][data-iris-min="1"] [data-iris-hud] .iris-chip,
[data-iris-overlay][data-iris-min="1"] [data-iris-hud] .iris-head-sp,
[data-iris-overlay][data-iris-min="1"] [data-iris-hud] [data-iris-min-btn],
[data-iris-overlay][data-iris-min="1"] [data-iris-hud] .iris-ctl,
[data-iris-overlay][data-iris-min="1"] [data-iris-hud] .iris-badge,
[data-iris-overlay][data-iris-min="1"] [data-iris-hud] .iris-act-strip,
[data-iris-overlay][data-iris-min="1"] [data-iris-hud] [data-iris-log],
[data-iris-overlay][data-iris-min="1"] [data-iris-hud] [data-iris-foot],
[data-iris-overlay][data-iris-min="1"] [data-iris-hud] .iris-banner{display:none;}
[data-iris-overlay][data-iris-min="1"] [data-iris-hud] .iris-live{display:block;}
[data-iris-overlay][data-iris-min="1"] [data-iris-hud] .iris-maxhint{display:inline-flex;}
[data-iris-mode="reading"] [data-iris-glow][data-on="1"]{
  box-shadow:inset 0 0 0 3px rgba(34,211,238,.9),inset 0 0 28px 6px rgba(34,211,238,.4);}
[data-iris-mode="reading"] [data-iris-ring]{border-color:#22d3ee;
  box-shadow:0 0 0 3px rgba(34,211,238,.25);}
[data-iris-overlay][data-iris-throttled="1"] [data-iris-glow][data-on="1"]{
  box-shadow:inset 0 0 0 3px rgba(251,191,36,.9),inset 0 0 28px 6px rgba(251,191,36,.45);}
[data-iris-overlay][data-iris-throttled="1"] [data-iris-hud]{--iris-accent:#fbbf24;--iris-accent-soft:rgba(251,191,36,.16);}
${LOG_CSS}
${CONTROLS_CSS}`;
