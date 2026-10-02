/**
 * Where the in-page HUD sits and what was switched, for HUD_USED events.
 *
 * Kept apart from the control list in `hud-controls.ts`: the wire schema needs these small enums on
 * every page load, and the list is only needed by the HUD itself and by the daemon that counts it.
 */

/** How the HUD sits on the page: the round bubble, the bare toolbar, or open on a panel. */
export const HudView = {
  BUBBLE: 'bubble',
  COLLAPSED: 'collapsed',
  EXPANDED: 'expanded',
} as const;
export type HudView = (typeof HudView)[keyof typeof HudView];

/** Which panel is showing, when the HUD is open. */
export const HudPanel = {
  CHAT: 'chat',
  SETTINGS: 'settings',
  REPORT: 'report',
  NONE: 'none',
} as const;
export type HudPanel = (typeof HudPanel)[keyof typeof HudPanel];

/** What a toggle was switched to; absent for a plain press. */
export const HudToggle = {
  ON: 'on',
  OFF: 'off',
} as const;
export type HudToggle = (typeof HudToggle)[keyof typeof HudToggle];
