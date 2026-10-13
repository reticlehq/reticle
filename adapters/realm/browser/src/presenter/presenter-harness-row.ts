/**
 * Reticle Harness in the HUD: one row at the foot of the Agent Log, and the Harness page it opens.
 *
 * The foot row says the state in two or three words and opens the page; while a drive runs it is the
 * drive's steps and Stop. The page holds everything else, each state as one sentence and the one
 * action that fixes it: sign in, link this project, raise the setup score, switch on, pick who to
 * test as and run. Linking is a button here, not a command to type: the daemon links the project of
 * the tab that asked.
 */
import {
  CreditKind,
  type AccountState,
  type HarnessConfig,
  type HarnessDrive,
} from '@reticlehq/core';
import {
  SIGN_UP_PITCH,
  creditsSpent,
  creditsUsageText,
  creditsUsedText,
  type Credits,
} from '@reticlehq/core/hud';
import { esc } from './chrome/presenter-safe-html.js';
import { ACCOUNT_SIGNIN_ATTR } from './presenter-account.js';
import { personaPickHtml, personaCustomHtml, personaLabel } from './presenter-personas.js';

export const HARNESS_ROW_TEXT = {
  RUN: 'Run Harness',
  /** Pressed, and the daemon has not said the drive is running yet: the same button, disabled. */
  STARTING: 'Starting…',
  STOP: 'Stop',
  SIGNED_OUT: SIGN_UP_PITCH,
  SIGN_IN: 'Sign in',
  UNLINKED: 'This project is not on your dashboard yet.',
  LINK: 'Link this project',
  LINKING: 'Linking…',
  NOT_ENTITLED: 'Harness is not on your plan',
  NO_CREDITS: 'No Harness credits left',
  NO_PROVIDER: 'No model provider set',
  OFF: 'Harness is off',
  /** At the coverage gate with the Harness off: it can be switched on now. */
  canSwitchOn: (percent: number): string => `Setup score ${String(percent)}%. Harness is off.`,
  TURN_ON: 'Switch on',
  COPY_PROMPT: 'Copy setup prompt',
  COPIED: 'Copied',
  SET_UP: 'Set up ↗',
  PLANS: 'See plans ↗',
  PLAN: 'Plan ↗',
  MORE: 'Get more ↗',
  driving: (as: string | undefined, steps: number): string =>
    `Driving${as === undefined ? '' : ` as ${as}`} · ${String(steps)} step${1 === steps ? '' : 's'}`,
  NAME: 'Harness',
  /** The switch's accessible name: it says what it does, whichever way it is. */
  TOGGLE: 'Reticle Harness on this project',
  /** Compact credits for the foot row; the full sentence is its tooltip. */
  creditsLeft: (left: number, days: number | undefined): string =>
    `${left.toLocaleString('en-US')} credit${1 === left ? '' : 's'}${days === undefined ? '' : ` · ${String(days)} day${1 === days ? '' : 's'}`}`,
  FOOT_LINK: 'Link project',
  FOOT_NO_CREDITS: 'No credits',
  FOOT_NOT_ENTITLED: 'Not on your plan',
  FOOT_NO_PROVIDER: 'No model provider',
  footSetup: (percent: number): string => `Setup ${String(percent)}% · needs 80%`,
  PAGE_TITLE: 'Reticle Harness',
  LOG_LABEL: 'What the Harness did',
  LOG_EMPTY: 'Runs show here, step by step.',
  PAGE_SUBTITLE: 'Tests your app by itself',
} as const;

/** Switches the Harness on, from its page: the same write-through the Settings switch makes. */
export const HARNESS_SWITCH_ON_ATTR = 'data-reticle-harness-switch';
/** Links this tab's project to the dashboard: the daemon does what `reticle connect` would. */
export const HARNESS_LINK_ATTR = 'data-reticle-harness-link';
/** The foot row's button: opens the Harness page. */
export const HARNESS_OPEN_ATTR = 'data-reticle-harness-open';
/** The Harness page's own log: every row the Harness drove or said, and nothing the agent did. */
export const HARNESS_LOG_ATTR = 'data-reticle-harness-log';
/** The foot row's on/off switch: the same write-through as Settings and the dashboard. */
export const HARNESS_TOGGLE_ATTR = 'data-reticle-harness-toggle';
/** Copies the prompt that closes the coverage gate. */
export const HARNESS_COPY_PROMPT_ATTR = 'data-reticle-harness-copy-prompt';

/** The Harness coverage gate, as the daemon pushes it on this tab's instrumentation. */
export interface HarnessGateView {
  percent: number;
  unlocked: boolean;
  reason?: string;
  /** The prompt for the coding agent that closes the gate. Copied, never rendered. */
  prompt?: string;
}

/**
 * The gate the HUD shows: the platform's when it sent one (it enforces it), with the local prompt
 * when it sent none; else the daemon's local score from this tab's instrumentation.
 */
export function harnessGateIn(
  instrumentation: Readonly<Record<string, unknown>> | undefined,
  config?: HarnessConfig,
): HarnessGateView | undefined {
  const local = localGateIn(instrumentation);
  const platform = config?.gate;
  if (platform === undefined) return local;
  const prompt = platform.prompt ?? local?.prompt;
  const reason = platform.unlocked ? undefined : (platform.reason ?? local?.reason);
  return {
    percent: platform.percent ?? local?.percent ?? 0,
    unlocked: platform.unlocked,
    ...(reason === undefined ? {} : { reason }),
    ...(prompt === undefined ? {} : { prompt }),
  };
}

/** The gate out of the loose `instrumentation` record, or undefined when an older daemon sent none. */
function localGateIn(
  instrumentation: Readonly<Record<string, unknown>> | undefined,
): HarnessGateView | undefined {
  const raw = instrumentation?.['harnessGate'];
  if ('object' !== typeof raw || null === raw) return undefined;
  const gate = raw as Record<string, unknown>;
  const percent = gate['percent'];
  const unlocked = gate['unlocked'];
  if ('number' !== typeof percent || 'boolean' !== typeof unlocked) return undefined;
  const reason = gate['reason'];
  const prompt = instrumentation?.['prompt'];
  return {
    percent: Math.round(percent),
    unlocked,
    ...('string' === typeof reason ? { reason } : {}),
    ...('string' === typeof prompt ? { prompt } : {}),
  };
}

export interface HarnessRowState {
  account: AccountState | undefined;
  config: HarnessConfig | undefined;
  /** This tab's coverage gate. Absent: an older daemon, which never locks. */
  gate?: HarnessGateView | undefined;
  drive: HarnessDrive | undefined;
  /** Whether this panel can start and stop drives at all. */
  canDrive: boolean;
  pick: string;
  /** The persona this panel started the running drive as, when it did. */
  startedAs: string | undefined;
  setupUrl: string;
  planUrl: string;
  /** A link the person asked for is under way: the button says so instead of offering it twice. */
  linking?: boolean;
  /** Run pressed and no drive reported yet: Run stays where it is, disabled, saying Starting…. */
  starting?: boolean;
}

const row = (inner: string): string => `<div class="reticle-harness-row">${inner}</div>`;
/** A row whose sentence wraps rather than truncates: one the person has to read whole. */
const wrapRow = (inner: string): string =>
  `<div class="reticle-harness-row reticle-harness-row-wrap">${inner}</div>`;
const said = (text: string): string => `<span class="reticle-harness-said">${text}</span>`;
/**
 * The Harness page's run row: what it runs as, then ONE button. The button is the row's last child in
 * every state (Run, Starting…, Stop), so a repaint changes it in place instead of swapping it out.
 */
const runRow = (lead: string, button: string): string =>
  row(`<span class="reticle-harness-lead">${lead}</span>${button}`);
const STOP_BUTTON = `<button type="button" data-reticle-harness-stop class="reticle-harness-run reticle-harness-stop">${HARNESS_ROW_TEXT.STOP}</button>`;
const link = (href: string, label: string): string =>
  `<a class="reticle-harness-link" href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;

/** "Trial: 120 of 500 credits used · 380 left", or nothing for an unbounded plan or none left. */
export function creditsShort(credits: Credits | undefined): string {
  return credits === undefined || creditsSpent(credits) ? '' : creditsUsageText(credits);
}

/** No credits left: the platform's sentence for the grant, and the one link that gets more. */
function creditsUsedRow(credits: Credits, planUrl: string): string {
  if (credits.kind === undefined)
    return row(`${said(HARNESS_ROW_TEXT.NO_CREDITS)}${link(planUrl, HARNESS_ROW_TEXT.MORE)}`);
  const text = creditsUsedText(credits);
  const action =
    text.action !== undefined
      ? link(planUrl, `${text.action} ↗`)
      : CreditKind.TRIAL === credits.kind
        ? link(planUrl, HARNESS_ROW_TEXT.PLAN)
        : '';
  return wrapRow(`${said(text.said)}${action}`);
}

/** The two or three words the foot row says for this state. */
function footState(s: HarnessRowState): string {
  if (true === s.starting) return HARNESS_ROW_TEXT.STARTING;
  const gate = s.gate;
  if (gate !== undefined && !gate.unlocked && gate.reason !== undefined)
    return HARNESS_ROW_TEXT.footSetup(gate.percent);
  const config = s.config;
  if (config === undefined) return HARNESS_ROW_TEXT.FOOT_LINK;
  if (config.credits !== undefined && creditsSpent(config.credits))
    return HARNESS_ROW_TEXT.FOOT_NO_CREDITS;
  if (!config.harnessEntitled) return HARNESS_ROW_TEXT.FOOT_NOT_ENTITLED;
  if (false === config.providerReady) return HARNESS_ROW_TEXT.FOOT_NO_PROVIDER;
  const credits = config.credits;
  return credits === undefined
    ? ''
    : HARNESS_ROW_TEXT.creditsLeft(Math.max(0, credits.limit - credits.used), credits.daysLeft);
}

/** The switch shows only where switching does something: linked, unlocked, entitled, credits left. */
function switchable(s: HarnessRowState): boolean {
  const config = s.config;
  if (config === undefined) return false;
  if (s.gate !== undefined && !s.gate.unlocked && s.gate.reason !== undefined) return false;
  if (config.credits !== undefined && creditsSpent(config.credits)) return false;
  return config.harnessEntitled && false !== config.providerReady;
}

/**
 * The foot of the Agent Log: signed out it is Sign in, while a drive runs it is the drive and Stop,
 * otherwise one button that names the state and opens the Harness page.
 */
export function harnessFootHtml(s: HarnessRowState): string {
  // Signed out the rail just below asks to sign in for the Harness: a row here was a second ask.
  if (s.account === undefined || !s.account.signedIn) return '';
  // A run in progress: its steps open the Harness page, where the run is shown; Stop stays here.
  if (s.drive !== undefined && s.canDrive)
    return row(
      `<button type="button" ${HARNESS_OPEN_ATTR} class="reticle-harness-open"><span class="reticle-harness-name">${HARNESS_ROW_TEXT.NAME}</span><span class="reticle-harness-state">${esc(HARNESS_ROW_TEXT.driving(s.startedAs === undefined ? undefined : personaLabel(s.startedAs), s.drive.steps))}</span><span class="reticle-harness-chev" aria-hidden="true">›</span></button>${STOP_BUTTON}`,
    );
  const on = true === s.config?.harnessEnabled;
  const credits = s.config?.credits;
  const title = credits === undefined ? '' : ` title="${esc(creditsUsageText(credits))}"`;
  const toggle = switchable(s)
    ? `<button type="button" role="switch" ${HARNESS_TOGGLE_ATTR} class="reticle-harness-toggle" aria-checked="${String(on)}" aria-label="${HARNESS_ROW_TEXT.TOGGLE}"><span class="reticle-harness-knob"></span></button>`
    : '';
  return row(
    `<button type="button" ${HARNESS_OPEN_ATTR} class="reticle-harness-open"${title}><span class="reticle-harness-name">${HARNESS_ROW_TEXT.NAME}</span><span class="reticle-harness-state">${esc(footState(s))}</span><span class="reticle-harness-chev" aria-hidden="true">›</span></button>${toggle}`,
  );
}

/** The Harness page's body for this state: one sentence and the action that fixes it. */
export function harnessRowHtml(s: HarnessRowState): string {
  // Unknown is not signed out: an older daemon, or the first push not here yet. Show nothing.
  if (s.account === undefined) return '';
  if (!s.account.signedIn)
    return wrapRow(
      `${said(HARNESS_ROW_TEXT.SIGNED_OUT)}<button type="button" ${ACCOUNT_SIGNIN_ATTR} class="reticle-harness-link">${HARNESS_ROW_TEXT.SIGN_IN}</button>`,
    );
  if (s.drive !== undefined && s.canDrive)
    return (
      runRow(
        said(
          HARNESS_ROW_TEXT.driving(
            s.startedAs === undefined ? undefined : personaLabel(s.startedAs),
            s.drive.steps,
          ),
        ),
        STOP_BUTTON,
      ) + personaCustomHtml(s.pick, true)
    );
  // The coverage gate before the platform's answers: it is this app's to fix, whatever the plan.
  const gate = s.gate;
  if (gate !== undefined && !gate.unlocked && gate.reason !== undefined)
    return wrapRow(
      `${said(esc(gate.reason))}${
        gate.prompt === undefined
          ? ''
          : `<button type="button" ${HARNESS_COPY_PROMPT_ATTR} class="reticle-harness-link">${HARNESS_ROW_TEXT.COPY_PROMPT}</button>`
      }`,
    );
  const config = s.config;
  if (config === undefined)
    return wrapRow(
      `${said(HARNESS_ROW_TEXT.UNLINKED)}<button type="button" ${HARNESS_LINK_ATTR} class="reticle-harness-run"${true === s.linking ? ' disabled' : ''}>${true === s.linking ? HARNESS_ROW_TEXT.LINKING : HARNESS_ROW_TEXT.LINK}</button>`,
    );
  // Credits first: the platform says none left as not entitled, and "not on your plan" was wrong.
  if (config.credits !== undefined && creditsSpent(config.credits))
    return creditsUsedRow(config.credits, s.planUrl);
  if (!config.harnessEntitled)
    return row(`${said(HARNESS_ROW_TEXT.NOT_ENTITLED)}${link(s.planUrl, HARNESS_ROW_TEXT.PLANS)}`);
  if (false === config.providerReady)
    return row(`${said(HARNESS_ROW_TEXT.NO_PROVIDER)}${link(s.setupUrl, HARNESS_ROW_TEXT.SET_UP)}`);
  if (!config.harnessEnabled)
    return row(
      `${said(gate === undefined ? HARNESS_ROW_TEXT.OFF : HARNESS_ROW_TEXT.canSwitchOn(gate.percent))}<button type="button" ${HARNESS_SWITCH_ON_ATTR} class="reticle-harness-run">${HARNESS_ROW_TEXT.TURN_ON}</button>`,
    );
  if (!s.canDrive) return '';
  const starting = true === s.starting;
  return (
    runRow(
      personaPickHtml(s.pick, starting),
      `<button type="button" data-reticle-harness-run class="reticle-harness-run"${starting ? ' disabled' : ''}>${starting ? HARNESS_ROW_TEXT.STARTING : HARNESS_ROW_TEXT.RUN}</button>`,
    ) + personaCustomHtml(s.pick, starting)
  );
}

export const HARNESS_ROW_CSS = `
[data-reticle-chat-panel] .reticle-harness-spot{flex:none;display:flex;flex-direction:column;gap:4px;}
[data-reticle-chat-panel] .reticle-harness-spot[hidden],[data-reticle-chat-panel] .reticle-harness-spot:empty{display:none;}
[data-reticle-chat-panel] .reticle-harness-row{display:flex;align-items:center;gap:6px;min-height:30px;min-width:0;}
[data-reticle-chat-panel] .reticle-harness-lead{flex:1;min-width:0;display:flex;align-items:center;gap:6px;}
[data-reticle-chat-panel] .reticle-harness-said{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:var(--reticle-hud-size-sm);color:var(--reticle-hud-text);}
[data-reticle-chat-panel] .reticle-harness-row-wrap{flex-wrap:wrap;row-gap:2px;padding:4px 0;}
[data-reticle-chat-panel] .reticle-harness-row-wrap .reticle-harness-said{flex:1 1 100%;white-space:normal;}
[data-reticle-chat-panel] .reticle-harness-said code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;}
[data-reticle-chat-panel] .reticle-harness-as{flex:none;font-size:var(--reticle-hud-size-xs);color:var(--reticle-hud-text-muted);}
[data-reticle-chat-panel] .reticle-harness-persona{box-sizing:border-box;flex:1;min-width:0;width:100%;height:30px;font:inherit;font-size:var(--reticle-hud-size-sm);color:var(--reticle-hud-text);
  background:var(--reticle-hud-ground);border:1px solid var(--reticle-hud-border-strong);border-radius:var(--reticle-hud-radius-sm);padding:0 var(--reticle-hud-space-2);}
[data-reticle-chat-panel] .reticle-harness-spot > .reticle-harness-persona{flex:none;}
[data-reticle-chat-panel] select.reticle-harness-persona{padding-right:2px;text-overflow:ellipsis;}
[data-reticle-chat-panel] .reticle-harness-persona::placeholder{color:var(--reticle-hud-text-faint);}
[data-reticle-chat-panel] .reticle-harness-persona:focus-visible{outline:2px solid var(--reticle-hud-brand);outline-offset:0;}
[data-reticle-chat-panel] .reticle-harness-run{flex:none;box-sizing:border-box;height:30px;padding:0 12px;border:0;border-radius:var(--reticle-hud-radius-sm);cursor:pointer;white-space:nowrap;
  background:var(--reticle-hud-brand);color:#160b02;font:inherit;font-size:var(--reticle-hud-size-sm);font-weight:700;}
[data-reticle-chat-panel] .reticle-harness-run:hover{filter:brightness(1.08);}
[data-reticle-chat-panel] .reticle-harness-run:focus-visible{outline:2px solid var(--reticle-hud-text);outline-offset:2px;}
[data-reticle-chat-panel] .reticle-harness-stop{background:transparent;color:var(--reticle-hud-text);border:1px solid var(--reticle-hud-border-strong);}
[data-reticle-chat-panel] .reticle-harness-link{flex:none;border:0;padding:0;background:none;cursor:pointer;font:inherit;color:var(--reticle-hud-brand);font-size:var(--reticle-hud-size-sm);font-weight:600;text-decoration:none;white-space:nowrap;}
[data-reticle-chat-panel] .reticle-harness-link:hover{text-decoration:underline;}
[data-reticle-chat-panel] .reticle-harness-open{flex:1;min-width:0;height:30px;display:flex;align-items:center;gap:8px;padding:0 var(--reticle-hud-space-2);border:0;border-radius:var(--reticle-hud-radius-sm);background:transparent;cursor:pointer;
  text-align:left;white-space:nowrap;font:inherit;font-size:var(--reticle-hud-size-sm);color:var(--reticle-hud-text);}
[data-reticle-chat-panel] .reticle-harness-name{flex:none;font-weight:600;}
[data-reticle-chat-panel] .reticle-harness-state{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--reticle-hud-text-muted);font-size:11px;font-variant-numeric:tabular-nums;}
[data-reticle-chat-panel] .reticle-harness-chev{flex:none;color:var(--reticle-hud-text-faint);}
[data-reticle-chat-panel] .reticle-harness-toggle{flex:none;position:relative;width:30px;height:18px;padding:0;border:0;border-radius:9px;cursor:pointer;background:var(--reticle-hud-border-strong);transition:background .15s;}
[data-reticle-chat-panel] .reticle-harness-toggle[aria-checked="true"]{background:var(--reticle-hud-brand);}
[data-reticle-chat-panel] .reticle-harness-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .15s;}
[data-reticle-chat-panel] .reticle-harness-toggle[aria-checked="true"] .reticle-harness-knob{transform:translateX(12px);}
[data-reticle-chat-panel] .reticle-harness-toggle:focus-visible{outline:2px solid var(--reticle-hud-text);outline-offset:2px;}
[data-reticle-chat-panel] .reticle-harness-open:hover{background:var(--reticle-hud-hover);}
[data-reticle-chat-panel] .reticle-harness-open:focus-visible{outline:2px solid var(--reticle-hud-brand);outline-offset:0;}
[data-reticle-chat-panel] .reticle-harness-run:disabled,[data-reticle-chat-panel] .reticle-harness-persona:disabled{opacity:.6;cursor:default;}
[data-reticle-chat-panel] .reticle-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;}
[data-reticle-chat-panel] .reticle-foot-meta{margin:0;font-size:11px;line-height:1.3;color:var(--reticle-hud-text-muted);overflow-wrap:anywhere;}
[data-reticle-chat-panel] .reticle-foot-meta:empty{display:none;}
`;
