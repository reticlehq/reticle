/**
 * Run Harness as one row at the foot of the Agent Log.
 *
 * It used to be a card (heading, paragraph, switch, persona field, hint, button) that took over half
 * the panel and squeezed the log, and the log is what a person opened the panel to read. Now every
 * state is one row: ready is a persona and Run, a drive is its status and Stop, and every reason it
 * cannot run is one short sentence and the one thing that fixes it. The on/off switch lives in
 * Settings only; what Harness does is said once, in the empty log.
 */
import type { AccountState, HarnessConfig, HarnessDrive } from '@reticlehq/core';
import { ACCOUNT_SIGNIN_ATTR } from './presenter-account.js';
import { personaPickHtml, personaCustomHtml, personaLabel } from './presenter-personas.js';

export const HARNESS_ROW_TEXT = {
  RUN: 'Run Harness',
  STOP: 'Stop',
  SIGNED_OUT: 'Sign in to use Harness',
  SIGN_IN: 'Sign in',
  UNLINKED: 'Not linked: run <code>reticle connect</code>',
  NOT_ENTITLED: 'Harness is not on your plan',
  NO_CREDITS: 'No Harness credits left',
  NO_PROVIDER: 'No model provider set',
  OFF: 'Harness is off',
  TURN_ON: 'Turn on',
  SET_UP: 'Set up ↗',
  PLANS: 'See plans ↗',
  MORE: 'Get more ↗',
  driving: (as: string | undefined, steps: number): string =>
    `Driving${as === undefined ? '' : ` as ${as}`} · ${String(steps)} step${1 === steps ? '' : 's'}`,
} as const;

/** Opens Settings on the Harness switch, the one place it lives. */
export const HARNESS_SETTINGS_ATTR = 'data-reticle-harness-settings';

export interface HarnessRowState {
  account: AccountState | undefined;
  config: HarnessConfig | undefined;
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
const said = (text: string): string => `<span class="reticle-harness-said">${text}</span>`;
const link = (href: string, label: string): string =>
  `<a class="reticle-harness-link" href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;

/** "4,706 credits left", or nothing for an unbounded plan: the platform's numbers, in credits. */
export function creditsShort(credits: { used: number; limit: number } | undefined): string {
  const left = credits === undefined ? 0 : Math.max(0, credits.limit - credits.used);
  // None left is said by the row itself ("No Harness credits left"), not twice.
  return 0 === left ? '' : `${left.toLocaleString('en-US')} credits left`;
}

/** The row for this state. Never more than one row, plus the custom box when Custom is picked. */
export function harnessRowHtml(s: HarnessRowState): string {
  // Unknown is not signed out: an older daemon, or the first push not here yet. Show nothing.
  if (s.account === undefined) return '';
  if (!s.account.signedIn)
    return row(
      `${said(HARNESS_ROW_TEXT.SIGNED_OUT)}<button type="button" ${ACCOUNT_SIGNIN_ATTR} class="reticle-harness-link">${HARNESS_ROW_TEXT.SIGN_IN}</button>`,
    );
  const config = s.config;
  if (config === undefined)
    return row(`${said(HARNESS_ROW_TEXT.UNLINKED)}${link(s.setupUrl, HARNESS_ROW_TEXT.SET_UP)}`);
  if (!config.harnessEntitled)
    return row(`${said(HARNESS_ROW_TEXT.NOT_ENTITLED)}${link(s.planUrl, HARNESS_ROW_TEXT.PLANS)}`);
  if (config.credits !== undefined && config.credits.used >= config.credits.limit)
    return row(`${said(HARNESS_ROW_TEXT.NO_CREDITS)}${link(s.planUrl, HARNESS_ROW_TEXT.MORE)}`);
  if (false === config.providerReady)
    return row(`${said(HARNESS_ROW_TEXT.NO_PROVIDER)}${link(s.setupUrl, HARNESS_ROW_TEXT.SET_UP)}`);
  if (s.drive !== undefined && s.canDrive)
    return row(
      `${said(HARNESS_ROW_TEXT.driving(s.startedAs === undefined ? undefined : personaLabel(s.startedAs), s.drive.steps))}<button type="button" data-reticle-harness-stop class="reticle-harness-run reticle-harness-stop">${HARNESS_ROW_TEXT.STOP}</button>`,
    );
  if (!config.harnessEnabled)
    return row(
      `${said(HARNESS_ROW_TEXT.OFF)}<button type="button" ${HARNESS_SETTINGS_ATTR} class="reticle-harness-link">${HARNESS_ROW_TEXT.TURN_ON}</button>`,
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
