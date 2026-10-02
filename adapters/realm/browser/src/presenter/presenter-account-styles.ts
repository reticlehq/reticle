/**
 * The account control's styling, in ONE place for all three surfaces that show it.
 *
 * It used to be three copies -- one scoped to the chat panel, one to the settings panel, one to the
 * report panel -- and they had drifted: `gap:4px` against `gap:6px`, `display:inline-flex` against
 * `display:flex`, and three different avatar sizes. The same control therefore looked like three
 * controls depending on where you met it, which is the one thing a shared component exists to
 * prevent.
 *
 * Deliberately UNSCOPED. Every rule keys off `.reticle-account*` alone, so a fourth surface gets the
 * design by mounting the markup and nothing else. The selectors all sit under the HUD's own root in
 * the document, and the class prefix is the namespace.
 */

import { HUD_DROP_SHADOW, HUD_SURFACE_PAINT } from './chrome/presenter-hud-chrome.js';

/** Tokens, so the three sizes that used to disagree now cannot. */
const AVATAR = 20;
const AVATAR_LG = 28;

export const ACCOUNT_CSS = `
/* The control establishes its own stacking context, and a high one.
   Its menu is absolutely positioned inside a panel whose other children (the log well, the act strip)
   are themselves positioned with their own z-index, so a z-index on the MENU alone was being compared
   inside the wrong context and lost to a sibling with a lower number. Raising it here, on the thing
   that contains the menu, is what actually puts the menu above them. 9 clears the workspace menu's 8,
   which is the highest in-panel chrome. */
/* The header row has to out-stack the log well, or nothing inside it can.
   .reticle-chat-head is position:relative with z-index:2, so it IS a stacking context and the number
   below is scoped inside it -- while the log well is a SIBLING, also at z-index:2, and later in DOM
   order. Equal z, later sibling wins, so the well painted over the whole header and took the open
   menu with it. The menu measured correctly and was invisible, which is the shape of bug that reads
   as "the dropdown does not work". Raising the header is what lets its children escape; the two only
   overlap while a menu is open, so nothing else moves. */
.reticle-chat-head{z-index:3;}
.reticle-account{position:relative;z-index:9;display:inline-flex;align-items:center;gap:6px;flex:none;}
.reticle-account-avatar{
  display:inline-flex;align-items:center;justify-content:center;
  width:${String(AVATAR)}px;height:${String(AVATAR)}px;border-radius:999px;
  font-size:9px;font-weight:600;letter-spacing:.02em;
  background:rgba(255,255,255,.12);color:rgba(255,255,255,.92);user-select:none;}
.reticle-account-avatar--lg{
  width:${String(AVATAR_LG)}px;height:${String(AVATAR_LG)}px;font-size:11px;}

/* The trigger is the avatar plus a hit area, never a second visual element: an avatar that looks
   like a button reads as an action, and this one opens a menu about a state. */
.reticle-account-trigger{
  display:inline-flex;align-items:center;justify-content:center;
  padding:0;border:none;background:transparent;cursor:pointer;line-height:0;border-radius:999px;
  transition:box-shadow .12s,opacity .12s;}
.reticle-account-trigger:hover{opacity:.85;}
.reticle-account-trigger:focus-visible{outline:none;box-shadow:0 0 0 2px rgba(255,255,255,.35);}
.reticle-account-trigger[aria-expanded="true"]{box-shadow:0 0 0 2px rgba(255,255,255,.28);}

.reticle-account-signin{
  border:none;border-radius:6px;padding:2px 9px;cursor:pointer;font:inherit;font-size:10.5px;
  background:rgba(255,255,255,.06);color:rgba(255,255,255,.75);transition:background .12s,color .12s;}
.reticle-account-signin:hover{background:rgba(255,255,255,.12);color:#fff;}

/* Anchored to the control and opening DOWNWARD.
   Not upward, which is what it looked like it wanted: all three surfaces mount this near the TOP of
   a panel whose own overflow is hidden for its rounded corners, so a menu opening upward is laid
   out correctly and then clipped away entirely -- present to the probe, invisible to the eye. Panels
   grow downward and have the height, so down is the direction that stays inside the box. */
.reticle-account-menu{
  position:absolute;right:0;top:calc(100% + 8px);z-index:6;
  min-width:212px;max-width:280px;padding:10px;box-sizing:border-box;
  display:flex;flex-direction:column;gap:8px;
  border-radius:10px;
  /* The HUD's own surface tokens, not a colour invented here. A menu with its own near-black is a
     second design language in the same panel, and a translucent one lets the panel's empty-state text
     read straight through the rows -- which is what the first version did. */
  ${HUD_SURFACE_PAINT}
  box-shadow:inset 0 1px 0 rgba(255,255,255,.09),${HUD_DROP_SHADOW};
  font-size:11px;color:rgba(255,255,255,.78);text-align:left;}
.reticle-account-menu[hidden]{display:none;}

.reticle-account-head{display:flex;align-items:center;gap:8px;min-width:0;}
.reticle-account-who{display:flex;flex-direction:column;min-width:0;gap:1px;}
.reticle-account-org{
  font-size:11.5px;font-weight:600;color:rgba(255,255,255,.95);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.reticle-account-email{
  font-size:10.5px;color:rgba(255,255,255,.55);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}

.reticle-account-rows{
  display:flex;flex-direction:column;gap:4px;
  padding-top:8px;border-top:1px solid rgba(255,255,255,.08);}
.reticle-account-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px;}
.reticle-account-k{color:rgba(255,255,255,.5);flex:none;}
.reticle-account-v{
  color:rgba(255,255,255,.88);min-width:0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-variant-numeric:tabular-nums;}

.reticle-account-actions{
  display:flex;flex-direction:column;gap:2px;
  padding-top:8px;border-top:1px solid rgba(255,255,255,.08);}
.reticle-account-action{
  display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;
  padding:5px 6px;border:none;border-radius:6px;cursor:pointer;
  font:inherit;font-size:11px;text-align:left;text-decoration:none;
  background:transparent;color:rgba(255,255,255,.8);transition:background .12s,color .12s;}
.reticle-account-action:hover{background:rgba(255,255,255,.08);color:#fff;}
.reticle-account-action:focus-visible{outline:none;background:rgba(255,255,255,.1);color:#fff;}
/* The unlinked hint is a sentence, not a verb: it wraps rather than truncating, because a clipped
   instruction is worse than a tall menu. */
.reticle-account-action--hint{
  color:rgba(255,255,255,.5);font-size:10.5px;line-height:1.35;white-space:normal;cursor:pointer;}

.reticle-account-dashboard{
  display:inline-flex;align-items:center;justify-content:center;
  border:none;background:transparent;color:rgba(255,255,255,.6);cursor:pointer;line-height:0;padding:2px;}
.reticle-account-dashboard:hover{color:#fff;}
`;
