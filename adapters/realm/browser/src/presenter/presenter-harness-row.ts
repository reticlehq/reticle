/**
 * Run Harness as one row at the foot of the Agent Log.
 *
 * It used to be a card (heading, paragraph, switch, persona field, hint, button) that took over half
 * the panel and squeezed the log, and the log is what a person opened the panel to read. Now every
 * state is one row: ready is a persona and Run, a drive is its status and Stop, and every reason it
 * cannot run is one short sentence and the one thing that fixes it. The on/off switch lives in
 * Settings only; what Harness does is said once, in the empty log.
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
  STOP: 'Stop',
  SIGNED_OUT: SIGN_UP_PITCH,
  SIGN_IN: 'Sign in',
  UNLINKED: 'Not linked: run <code>reticle connect</code>',
  NOT_ENTITLED: 'Harness is not on your plan',
  NO_CREDITS: 'No Harness credits left',
  NO_PROVIDER: 'No model provider set',
  OFF: 'Harness is off',
  /** At the coverage gate with the Harness off: it can be switched on now. */
  canSwitchOn: (percent: number): string =>
    `This app is at ${String(percent)}% instrumentation: Harness can be switched on`,
  TURN_ON: 'Turn on',
  COPY_PROMPT: 'Copy prompt for your coding agent',
  COPIED: 'Copied',
  SET_UP: 'Set up ↗',
  PLANS: 'See plans ↗',
  PLAN: 'Plan ↗',
  MORE: 'Get more ↗',
  driving: (as: string | undefined, steps: number): string =>
    `Driving${as === undefined ? '' : ` as ${as}`} · ${String(steps)} step${1 === steps ? '' : 's'}`,
} as const;

/** Opens Settings on the Harness switch, the one place it lives. */
export const HARNESS_SETTINGS_ATTR = 'data-reticle-harness-settings';
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
}

const row = (inner: string): string => `<div class="reticle-harness-row">${inner}</div>`;
/** A row whose sentence wraps rather than truncates: one the person has to read whole. */
const wrapRow = (inner: string): string =>
  `<div class="reticle-harness-row reticle-harness-row-wrap">${inner}</div>`;
const said = (text: string): string => `<span class="reticle-harness-said">${text}</span>`;
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

/** The row for this state. Never more than one row, plus the custom box when Custom is picked. */
export function harnessRowHtml(s: HarnessRowState): string {
  // Unknown is not signed out: an older daemon, or the first push not here yet. Show nothing.
  if (s.account === undefined) return '';
  if (!s.account.signedIn)
    return wrapRow(
      `${said(HARNESS_ROW_TEXT.SIGNED_OUT)}<button type="button" ${ACCOUNT_SIGNIN_ATTR} class="reticle-harness-link">${HARNESS_ROW_TEXT.SIGN_IN}</button>`,
    );
  if (s.drive !== undefined && s.canDrive)
    return row(
      `${said(HARNESS_ROW_TEXT.driving(s.startedAs === undefined ? undefined : personaLabel(s.startedAs), s.drive.steps))}<button type="button" data-reticle-harness-stop class="reticle-harness-run reticle-harness-stop">${HARNESS_ROW_TEXT.STOP}</button>`,
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
    return row(`${said(HARNESS_ROW_TEXT.UNLINKED)}${link(s.setupUrl, HARNESS_ROW_TEXT.SET_UP)}`);
  // Credits first: the platform says none left as not entitled, and "not on your plan" was wrong.
  if (config.credits !== undefined && creditsSpent(config.credits))
    return creditsUsedRow(config.credits, s.planUrl);
  if (!config.harnessEntitled)
    return row(`${said(HARNESS_ROW_TEXT.NOT_ENTITLED)}${link(s.planUrl, HARNESS_ROW_TEXT.PLANS)}`);
  if (false === config.providerReady)
    return row(`${said(HARNESS_ROW_TEXT.NO_PROVIDER)}${link(s.setupUrl, HARNESS_ROW_TEXT.SET_UP)}`);
  if (!config.harnessEnabled)
    return row(
      `${said(gate === undefined ? HARNESS_ROW_TEXT.OFF : HARNESS_ROW_TEXT.canSwitchOn(gate.percent))}<button type="button" ${HARNESS_SETTINGS_ATTR} class="reticle-harness-link">${HARNESS_ROW_TEXT.TURN_ON}</button>`,
    );
  if (!s.canDrive) return '';
  return (
    row(
      `${personaPickHtml(s.pick)}<button type="button" data-reticle-harness-run class="reticle-harness-run">${HARNESS_ROW_TEXT.RUN}</button>`,
    ) + personaCustomHtml(s.pick)
  );
}

export const HARNESS_ROW_CSS = `
[data-reticle-chat-panel] .reticle-harness-spot{flex:none;display:flex;flex-direction:column;gap:4px;}
[data-reticle-chat-panel] .reticle-harness-spot[hidden],[data-reticle-chat-panel] .reticle-harness-spot:empty{display:none;}
[data-reticle-chat-panel] .reticle-harness-row{display:flex;align-items:center;gap:6px;min-height:30px;min-width:0;}
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
[data-reticle-chat-panel] .reticle-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;}
[data-reticle-chat-panel] .reticle-foot-meta{margin:0;font-size:11px;line-height:1.3;color:var(--reticle-hud-text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-reticle-chat-panel] .reticle-foot-meta:empty{display:none;}
`;
