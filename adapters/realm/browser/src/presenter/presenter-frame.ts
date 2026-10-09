/**
 * The one frame every HUD page sits in, and the rail underneath it.
 *
 * Log, Flows, Notes, Impact and Settings each grew their own card: four widths, four heights from
 * 533px to 702px, three surfaces, and a settings card that hung over the minimised-chat capsule.
 * Switching tabs made the HUD jump, and the tallest of them covered most of a laptop screen. Every
 * page now takes the same slot, size and surface from here, and this sheet is injected LAST so it
 * wins over each panel's own geometry without touching their internals.
 *
 * The rail is the strip between the open page and the toolbar, shared by every page. Signed out it
 * asks for a sign-in and says what it unlocks (the Harness); signed in it carries the promo slides.
 * It is one element outside every panel, so a page added later cannot forget it.
 */
import type { AccountState } from '@reticlehq/core';
import { ACCOUNT_SIGNIN_ATTR, ACCOUNT_TEXT } from './presenter-account.js';
import {
  CHAT_ATTR,
  CHAT_PILL_ATTR,
  CHAT_PLACEMENT_ATTR,
  DOCK_ALIGN_ATTR,
  DOCK_ATTR,
  MIN_ATTR,
  REPORT_ATTR,
  REPORT_PANEL_ATTR,
  SETTINGS_ATTR,
  SETTINGS_PANEL_ATTR,
  SETTINGS_PLACEMENT_ATTR,
  CHAT_PANEL_ATTR,
} from './presenter-config.js';
import { HUD_DROP_SHADOW, HUD_GLASS_PAINT } from './chrome/presenter-hud-chrome.js';

export const RAIL_ATTR = 'data-reticle-rail';
export const RAIL_SIGNIN_ATTR = 'data-reticle-rail-signin';
export const RAIL_PROMO_ATTR = 'data-reticle-rail-promo';
const PAGE_OPEN_ATTR = 'data-reticle-page-open';
const PAGE_PANEL_ATTR = 'data-reticle-page-panel';
const OVERLAY = 'data-reticle-overlay';

export const RAIL_TEXT = {
  // Signing in is the whole step: every workspace, Free included, gets Harness credits each month.
  TITLE: 'Sign in to try Reticle Harness',
  DETAIL: 'Free Harness credits to start.',
  CTA: 'Sign in',
} as const;

export const RAIL_HTML = `<div ${RAIL_ATTR} class="reticle-rail" role="complementary" aria-label="Reticle">
  <div ${RAIL_SIGNIN_ATTR} class="reticle-rail-signin" hidden>
    <span class="reticle-rail-copy"><strong>${RAIL_TEXT.TITLE}</strong><span>${RAIL_TEXT.DETAIL}</span></span>
    <button type="button" ${ACCOUNT_SIGNIN_ATTR} class="reticle-rail-cta" title="${ACCOUNT_TEXT.SIGNIN_TITLE}">${RAIL_TEXT.CTA}</button>
  </div>
  <div ${RAIL_PROMO_ATTR} class="reticle-rail-promo"></div>
</div>`;

/**
 * Signed out: the sign-in ask replaces the promo. Unknown (no push yet, or no cloud at all): the
 * promo, because a sign-in prompt for an account state nobody has reported would be a guess.
 */
export function paintRail(root: HTMLElement, account: AccountState | undefined): void {
  const signin = root.querySelector<HTMLElement>(`[${RAIL_SIGNIN_ATTR}]`);
  const promo = root.querySelector<HTMLElement>(`[${RAIL_PROMO_ATTR}]`);
  const signedOut = account !== undefined && !account.signedIn;
  if (signin !== null) signin.hidden = !signedOut;
  if (promo !== null) promo.hidden = signedOut;
}

const PAGES = `:is([${CHAT_PANEL_ATTR}],[${PAGE_PANEL_ATTR}],[${REPORT_PANEL_ATTR}],[${SETTINGS_PANEL_ATTR}])`;
const ANY_OPEN = `[${OVERLAY}][${MIN_ATTR}="0"]:is([${CHAT_ATTR}="1"],[${PAGE_OPEN_ATTR}],[${REPORT_ATTR}="1"],[${SETTINGS_ATTR}="1"])`;
const BELOW = `[${DOCK_ATTR}]:is([${CHAT_PLACEMENT_ATTR}="below"],[${SETTINGS_PLACEMENT_ATTR}="below"])`;

export const FRAME_CSS = `
[${DOCK_ATTR}]{
  /* Short enough to leave most of a laptop screen to the app; the log scrolls inside it. */
  --reticle-frame-h:min(440px,60vh,calc(100vh - 190px));
  --reticle-rail-h:52px;--reticle-frame-gap:6px;}
[${DOCK_ATTR}] ${PAGES}{
  right:0;left:auto;top:auto;
  bottom:calc(100% + 8px + var(--reticle-rail-h) + var(--reticle-frame-gap));
  width:var(--reticle-dock-w);max-width:min(var(--reticle-dock-w),calc(100vw - 24px));
  height:var(--reticle-frame-h);max-height:var(--reticle-frame-h);
  border-radius:var(--reticle-hud-radius-lg);
  ${HUD_GLASS_PAINT}}
[${DOCK_ATTR}] [${SETTINGS_PANEL_ATTR}]::after{display:none;}
[${DOCK_ATTR}] [${SETTINGS_PANEL_ATTR}] .reticle-settings-inner{height:100%;}
[${DOCK_ATTR}] [${SETTINGS_PANEL_ATTR}] :is(.reticle-settings-body,.reticle-settings-foot){background:transparent;}
[${DOCK_ATTR}] [${REPORT_PANEL_ATTR}] .reticle-report-inner{height:100%;}
/* The Agent Log section fills the frame, so the footer sits on the bottom edge, not mid-panel. */
[${CHAT_PANEL_ATTR}] .reticle-chat-view{flex:1;min-height:0;display:flex;flex-direction:column;}
[${CHAT_PANEL_ATTR}] .reticle-chat-view > .reticle-hud-log-well{flex:1;min-height:0;}
/*
 * Two rows above the log in every state: the header and the status row. "Session ended" (or the
 * handoff notice) takes the status text's place instead of arriving as a row of its own, and the
 * Harness block sits in the footer above the project capsule.
 */
[${OVERLAY}] [${CHAT_PANEL_ATTR}] .reticle-act-strip .reticle-banner{display:none;flex:1;min-width:0;min-height:0;padding:0;border:0;background:none;
  font-size:11px;font-weight:600;line-height:1.3;color:var(--reticle-hud-text);
  overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2;}
[${OVERLAY}][data-reticle-state="ended"] [${CHAT_PANEL_ATTR}] .reticle-act-strip .reticle-banner{display:-webkit-box;}
[${OVERLAY}][data-reticle-state="ended"] [${CHAT_PANEL_ATTR}] .reticle-act-strip .reticle-act{display:none;}
[${CHAT_PANEL_ATTR}] .reticle-foot-workspace-row{gap:var(--reticle-hud-space-2);}
/* The Harness block sits above the project capsule, full width: one clear thing to press. */
[${CHAT_PANEL_ATTR}] [data-reticle-foot] .reticle-foot-stack{display:flex;flex-direction:column;gap:var(--reticle-hud-space-2);}
[${CHAT_PANEL_ATTR}] [data-reticle-foot] .reticle-foot-workspace-row:has(> .reticle-workspace-wrap[hidden]){display:none;}
${BELOW} ${PAGES}{bottom:auto;top:calc(100% + 8px + var(--reticle-rail-h) + var(--reticle-frame-gap));}
[${DOCK_ATTR}][${DOCK_ALIGN_ATTR}="start"] :is(${PAGES},[${RAIL_ATTR}]){right:auto;left:0;}

/* ── Every page's header: title over a one-line subtitle, its actions, then close. ────────────── */
[${DOCK_ATTR}] :is(.reticle-page-heading,.reticle-report-head,.reticle-settings-head){
  flex:none;display:flex;align-items:center;gap:var(--reticle-hud-space-2);min-height:52px;box-sizing:border-box;
  padding:var(--reticle-hud-space-2) var(--reticle-hud-space-2) var(--reticle-hud-space-2) var(--reticle-hud-space-3);
  border-bottom:1px solid var(--reticle-hud-border);background:none;}
[${DOCK_ATTR}] .reticle-page-titles{display:flex;flex:1;min-width:0;flex-direction:column;gap:1px;}
[${DOCK_ATTR}] :is(.reticle-page-heading strong,.reticle-report-title,.reticle-settings-title){
  font-size:var(--reticle-hud-size-base);font-weight:600;letter-spacing:0;text-transform:none;color:var(--reticle-hud-text);}
[${DOCK_ATTR}] .reticle-settings-title{flex:1;}
[${DOCK_ATTR}] .reticle-page-heading .reticle-page-subtitle{padding:0;border:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:var(--reticle-hud-size-xs);color:var(--reticle-hud-text-muted);}
[${DOCK_ATTR}] .reticle-primary-btn{flex:none;display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 var(--reticle-hud-space-3);
  border:0;border-radius:var(--reticle-hud-radius-pill);background:var(--reticle-hud-brand);color:#160b02;
  font:inherit;font-size:var(--reticle-hud-size-sm);font-weight:700;white-space:nowrap;cursor:pointer;}
[${DOCK_ATTR}] .reticle-primary-btn:hover{filter:brightness(1.08);}
[${DOCK_ATTR}] .reticle-page-heading .reticle-primary-btn{width:auto;height:28px;border-radius:var(--reticle-hud-radius-pill);background:var(--reticle-hud-brand);color:#160b02;font-size:var(--reticle-hud-size-sm);}
/* One close control everywhere: a quiet 28px square, the same glyph weight on every page. */
[${DOCK_ATTR}] :is([data-reticle-page-close],.reticle-report-close,.reticle-settings-close){flex:none;width:28px;height:28px;
  display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:var(--reticle-hud-radius-sm);
  background:transparent;color:var(--reticle-hud-text-muted);font-size:18px;line-height:1;cursor:pointer;}
[${DOCK_ATTR}] :is([data-reticle-page-close],.reticle-report-close,.reticle-settings-close):hover{background:var(--reticle-hud-hover);color:var(--reticle-hud-text);}
[${DOCK_ATTR}] .reticle-primary-btn[data-active="1"]{background:var(--reticle-hud-text);color:var(--reticle-hud-ground);}
[${DOCK_ATTR}] .reticle-primary-btn svg{display:block;fill:none;stroke:currentColor;stroke-width:1.8;}
/* One empty state for every page: what is missing, then how it gets filled. */
[${DOCK_ATTR}] :is(.reticle-flows-empty,.reticle-annotation-empty){display:flex;flex-direction:column;align-items:center;gap:6px;
  margin:auto 0;padding:40px var(--reticle-hud-space-4);text-align:center;}
[${DOCK_ATTR}] :is(.reticle-flows-empty,.reticle-annotation-empty) strong{font-size:var(--reticle-hud-size-base);font-weight:600;color:var(--reticle-hud-text);}
[${DOCK_ATTR}] :is(.reticle-flows-empty,.reticle-annotation-empty) span{max-width:260px;font-size:var(--reticle-hud-size-sm);line-height:1.45;color:var(--reticle-hud-text-muted);}

/* ── Saved flows: one row per journey. ───────────────────────────────────────────────────────── */
[${PAGE_PANEL_ATTR}="flows"] .reticle-all-flows{display:flex;flex-direction:column;gap:var(--reticle-hud-space-1);padding:var(--reticle-hud-space-2);}
[${PAGE_PANEL_ATTR}="flows"] .reticle-flow-row{display:flex;align-items:center;gap:var(--reticle-hud-space-3);width:100%;min-height:48px;
  padding:var(--reticle-hud-space-2) var(--reticle-hud-space-3);border:1px solid transparent;border-radius:var(--reticle-hud-radius-md);
  background:transparent;color:var(--reticle-hud-text);font:inherit;text-align:left;cursor:pointer;}
[${PAGE_PANEL_ATTR}="flows"] .reticle-flow-row:hover:not(:disabled){background:var(--reticle-hud-hover);border-color:var(--reticle-hud-border);}
[${PAGE_PANEL_ATTR}="flows"] .reticle-flow-row:focus-visible{outline:2px solid var(--reticle-hud-brand);outline-offset:1px;}
[${PAGE_PANEL_ATTR}="flows"] .reticle-flow-row:disabled{cursor:not-allowed;opacity:.5;}
[${PAGE_PANEL_ATTR}="flows"] .reticle-flow-play{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;
  border-radius:50%;background:var(--reticle-hud-brand-soft);color:var(--reticle-hud-brand);font-size:11px;}
[${PAGE_PANEL_ATTR}="flows"] .reticle-flow-row:disabled .reticle-flow-play{background:var(--reticle-hud-inset);color:var(--reticle-hud-text-faint);}
[${PAGE_PANEL_ATTR}="flows"] .reticle-flow-text{display:flex;flex:1;min-width:0;flex-direction:column;gap:1px;}
[${PAGE_PANEL_ATTR}="flows"] .reticle-flow-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--reticle-hud-size-sm);font-weight:600;}
[${PAGE_PANEL_ATTR}="flows"] .reticle-flow-meta{font-size:var(--reticle-hud-size-xs);color:var(--reticle-hud-text-muted);}

/* ── Notes: a segmented list switch, then the page's tools on the right. ─────────────────────── */
[${PAGE_PANEL_ATTR}="annotations"] .reticle-annotations-tabs{gap:var(--reticle-hud-space-1);padding:var(--reticle-hud-space-2) var(--reticle-hud-space-3);}
/* One segmented switch for every "show me this or that": Notes' list and Impact's scope. */
[${DOCK_ATTR}] .reticle-segmented{display:inline-flex;flex:none;padding:2px;border-radius:var(--reticle-hud-radius-sm);background:var(--reticle-hud-inset);}
[${PAGE_PANEL_ATTR}="annotations"] .reticle-segmented{margin-right:auto;}
[${DOCK_ATTR}] .reticle-segmented button{height:24px;padding:0 var(--reticle-hud-space-3);border:0;border-radius:4px;background:transparent;
  color:var(--reticle-hud-text-muted);font:inherit;font-size:var(--reticle-hud-size-xs);white-space:nowrap;cursor:pointer;}
[${DOCK_ATTR}] .reticle-segmented button:hover{color:var(--reticle-hud-text);}
[${DOCK_ATTR}] .reticle-segmented button[aria-pressed="true"]{background:var(--reticle-hud-border-strong);color:var(--reticle-hud-text);}
[${DOCK_ATTR}] .reticle-report-head .reticle-segmented{margin-left:auto;}
[${PAGE_PANEL_ATTR}="annotations"] .reticle-annotations-tabs .reticle-copy-all{margin-left:0;color:var(--reticle-hud-text-muted);}
[${PAGE_PANEL_ATTR}="annotations"] .reticle-annotation-list{display:flex;flex-direction:column;}
[${PAGE_PANEL_ATTR}="annotations"] .reticle-annotation-item{padding:var(--reticle-hud-space-3) 2px;}

/* ── Impact: the streak and the account share the first line instead of a row each. ─────────── */
[${REPORT_PANEL_ATTR}] .reticle-report-top{display:flex;align-items:center;justify-content:space-between;gap:var(--reticle-hud-space-2);min-height:28px;margin-bottom:var(--reticle-hud-space-2);}
[${REPORT_PANEL_ATTR}] .reticle-report-top .reticle-report-streak{margin-bottom:0;}
[${REPORT_PANEL_ATTR}] .reticle-report-top .reticle-report-identity{margin:0 0 0 auto;padding:0;}
[${REPORT_PANEL_ATTR}] .reticle-report-hero-value{color:var(--reticle-hud-text);}
[${REPORT_PANEL_ATTR}] .reticle-report-card{background:var(--reticle-hud-inset);border-radius:var(--reticle-hud-radius-md);}
[${REPORT_PANEL_ATTR}] :is(.reticle-report-foot,.reticle-report-links){padding-left:var(--reticle-hud-space-3);padding-right:var(--reticle-hud-space-3);}

/* ── Settings: the help links scroll with the rest instead of pinning a footer over the options. */
[${SETTINGS_PANEL_ATTR}] .reticle-settings-body .reticle-settings-foot{margin-top:0;border-top:0;}
[${SETTINGS_PANEL_ATTR}] .reticle-settings-row{flex-wrap:wrap;}
[${SETTINGS_PANEL_ATTR}] .reticle-settings-helptext{flex-basis:100%;margin:6px 0 2px;font-size:var(--reticle-hud-size-xs);line-height:1.45;color:var(--reticle-hud-text-muted);}
[${SETTINGS_PANEL_ATTR}] .reticle-settings-help[aria-expanded="true"]{color:var(--reticle-hud-brand);}
[${SETTINGS_PANEL_ATTR}] .reticle-settings-reset{background:none;text-align:left;padding-left:14px;font-weight:500;}

/* ── Toolbar: Settings and Exit are tabs like the four beside them, so they light the same way. ── */
[data-reticle-hud] .reticle-toolbar-chrome .reticle-tb-btn{width:var(--reticle-hud-control-size);height:var(--reticle-hud-control-size);
  border-radius:var(--reticle-hud-radius-md);background:transparent;color:var(--reticle-hud-text-muted);}
[data-reticle-hud] .reticle-toolbar-chrome .reticle-tb-btn:hover{background:var(--reticle-hud-hover);color:var(--reticle-hud-text);}
[data-reticle-hud] .reticle-toolbar-chrome .reticle-tb-btn[data-active="1"],
[data-reticle-hud] .reticle-toolbar-chrome .reticle-tb-btn[data-active="1"]:hover{background:var(--reticle-hud-inset);color:var(--reticle-hud-text);}

[${RAIL_ATTR}]{
  display:none;position:absolute;right:0;left:auto;bottom:calc(100% + 8px);z-index:7;
  box-sizing:border-box;width:var(--reticle-dock-w);max-width:min(var(--reticle-dock-w),calc(100vw - 24px));
  height:var(--reticle-rail-h);padding:0 var(--reticle-hud-space-3);align-items:center;
  border:1px solid color-mix(in srgb,var(--reticle-hud-brand) 30%,var(--reticle-hud-border));
  border-radius:var(--reticle-hud-radius-lg);
  background:linear-gradient(135deg,var(--reticle-hud-brand-soft),var(--reticle-hud-surface) 65%);
  box-shadow:${HUD_DROP_SHADOW};color:var(--reticle-hud-text);font-family:var(--reticle-font);
  pointer-events:auto;}
${BELOW} [${RAIL_ATTR}]{bottom:auto;top:calc(100% + 8px);}
${ANY_OPEN} [${RAIL_ATTR}]{display:flex;}
/* The capsule and the rail share a slot: the capsule is for "nothing open", the rail for "a page is". */
${ANY_OPEN} [${CHAT_PILL_ATTR}]{display:none !important;}
[${RAIL_ATTR}] > [hidden]{display:none !important;}
[${RAIL_ATTR}] .reticle-rail-signin,[${RAIL_ATTR}] .reticle-rail-promo{flex:1;min-width:0;}
[${RAIL_ATTR}] .reticle-rail-signin{display:flex;align-items:center;gap:var(--reticle-hud-space-3);}
[${RAIL_ATTR}] .reticle-rail-copy{display:flex;flex:1;min-width:0;flex-direction:column;line-height:1.3;}
[${RAIL_ATTR}] .reticle-rail-copy strong{font-size:var(--reticle-hud-size-sm);font-weight:600;}
[${RAIL_ATTR}] .reticle-rail-copy span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--reticle-hud-size-xs);color:var(--reticle-hud-text-muted);}
[${RAIL_ATTR}] .reticle-rail-cta{flex:none;height:28px;padding:0 var(--reticle-hud-space-3);border:0;border-radius:var(--reticle-hud-radius-pill);
  background:var(--reticle-hud-brand);color:#160b02;font:inherit;font-size:var(--reticle-hud-size-sm);font-weight:700;cursor:pointer;}
[${RAIL_ATTR}] .reticle-rail-cta:hover{filter:brightness(1.08);}
[${RAIL_ATTR}] .reticle-rail-cta:focus-visible{outline:2px solid var(--reticle-hud-text);outline-offset:2px;}
/* The promo: one line of copy, its link, and dots. The carousel draws no frame of its own here. */
[${RAIL_ATTR}] .reticle-carousel{margin:0;padding:0;border:0;background:none;}
[${RAIL_ATTR}] .reticle-carousel-track{height:32px;overflow:hidden;}
[${RAIL_ATTR}] :is(.reticle-carousel-close,.reticle-carousel-arrow,[data-reticle-carousel-position]){display:none;}
[${RAIL_ATTR}] .reticle-carousel-controls{position:absolute;right:var(--reticle-hud-space-3);top:6px;height:auto;margin:0;}
[${RAIL_ATTR}] .reticle-carousel-dots{position:static;display:flex;gap:4px;margin:0;}
[${RAIL_ATTR}] .reticle-carousel-dot{width:10px;height:3px;padding:0;border:0;border-radius:99px;background:var(--reticle-hud-text-muted);opacity:.35;cursor:pointer;}
[${RAIL_ATTR}] .reticle-carousel-dot[aria-current="true"]{background:var(--reticle-hud-brand);opacity:1;}
[${RAIL_ATTR}] .reticle-promo-copy{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:8px;padding-right:0;}
[${RAIL_ATTR}] .reticle-promo-kicker{display:none;}
[${RAIL_ATTR}] .reticle-promo-title{grid-column:1/-1;overflow:hidden;padding-right:40px;font-size:var(--reticle-hud-size-sm);font-weight:600;line-height:1.3;text-overflow:ellipsis;white-space:nowrap;}
[${RAIL_ATTR}] .reticle-promo-detail{grid-column:1;overflow:hidden;color:var(--reticle-hud-text-muted);font-size:var(--reticle-hud-size-xs);line-height:1.3;text-overflow:ellipsis;white-space:nowrap;}
[${RAIL_ATTR}] .reticle-promo-link{position:static;grid-column:2;color:var(--reticle-hud-brand);font-size:var(--reticle-hud-size-xs);font-weight:600;text-decoration:none;white-space:nowrap;}
[${RAIL_ATTR}] .reticle-promo-link:hover{text-decoration:underline;}
`;
