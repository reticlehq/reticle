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

/**
 * Which page is showing, when the HUD is open: the Agent Log (`chat`), the Flows and Notes pages
 * inside it, Impact (`report`) or Settings. Timed per page, so how long somebody spends on each is a
 * number rather than a guess.
 */
export const HudPanel = {
  CHAT: 'chat',
  FLOWS: 'flows',
  NOTES: 'notes',
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

/**
 * What an agent may do with the HUD when it sits over what it has to test (reticle_session tune).
 * `removed` takes it off the page until the next reload; `hidden` keeps it ready to come back.
 */
export const HudVisibility = {
  SHOWN: 'shown',
  HIDDEN: 'hidden',
  REMOVED: 'removed',
} as const;
export type HudVisibility = (typeof HudVisibility)[keyof typeof HudVisibility];

/** The corner an agent can move the HUD to; `bottom-right` is where it docks by default. */
export const HudCorner = {
  TOP_LEFT: 'top-left',
  TOP_RIGHT: 'top-right',
  BOTTOM_LEFT: 'bottom-left',
  BOTTOM_RIGHT: 'bottom-right',
} as const;
export type HudCorner = (typeof HudCorner)[keyof typeof HudCorner];

/** Where a replay the human started from the HUD stands, for the chip's progress bar. */
export const FlowProgressStatus = {
  PLAYING: 'playing',
  PASSED: 'passed',
  FAILED: 'failed',
} as const;
export type FlowProgressStatus = (typeof FlowProgressStatus)[keyof typeof FlowProgressStatus];

/** Where one part of a Harness drive plan stands. */
export const ScriptStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  PASSED: 'passed',
  FAILED: 'failed',
  /** Never started: something it needed failed. */
  BLOCKED: 'blocked',
  /** A branch case whose condition did not hold. Not a failure. */
  NOT_TAKEN: 'not-taken',
} as const;
export type ScriptStatus = (typeof ScriptStatus)[keyof typeof ScriptStatus];

/** The HUD's picture of a drive plan: lanes side by side, journeys in order, steps inside. */
export interface PlanView {
  /** Lanes that may run at once. */
  parallel: number;
  lanes: {
    id: string;
    journeys: {
      id: string;
      title: string;
      persona?: string;
      /** Journeys in earlier lanes this one waits on. */
      waitsOn: string[];
      status: ScriptStatus;
      steps: { label: string; status: ScriptStatus }[];
    }[];
  }[];
}
