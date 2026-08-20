import type { ImpactScope, ImpactSnapshot } from '@reticlehq/core';
import { PresenterIcon, PRESENTER_ICON_SIZE, hiIconHtml } from './presenter-icons.js';
import { HUD_SURFACE_CLASS } from './presenter-hud-chrome.js';
import { REPORT_PANEL_ATTR, REPORT_ATTR, REPORT_CLOSE_ATTR } from './presenter-config.js';
import {
  REPORT_LINKS,
  REPORT_TEXT,
  buildLinkedInShareUrl,
  buildReferralText,
  buildShareText,
  buildXShareUrl,
  compactDuration,
  compactNumber,
} from './presenter-report-copy.js';

/**
 * The impact report: what Reticle has actually done for this user.
 *
 * Reads the local record only - the panel is a view over `.reticle/impact.json`, pushed by the
 * daemon, never fetched from us. Two scopes (this project, this machine) behind one toggle.
 */

const SCOPE_ATTR = 'data-reticle-report-scope';
const SHARE_X_ATTR = 'data-reticle-share-x';
const SHARE_IN_ATTR = 'data-reticle-share-in';
const SHARE_COPY_ATTR = 'data-reticle-share-copy';
const REFER_ATTR = 'data-reticle-refer';
const COPIED_FLASH_MS = 1600;

export function reportPanelHtml(): string {
  const close = hiIconHtml(PresenterIcon.REMOVE, PRESENTER_ICON_SIZE.MIN);
  return `<div ${REPORT_PANEL_ATTR} class="reticle-report ${HUD_SURFACE_CLASS}" role="dialog" aria-label="Reticle impact" aria-hidden="true">
    <div class="reticle-report-inner">
      <div class="reticle-report-head">
        <span class="reticle-report-title">${REPORT_TEXT.TITLE}</span>
        <button type="button" ${SCOPE_ATTR} class="reticle-report-scope" aria-pressed="false">${REPORT_TEXT.PROJECT}</button>
        <button type="button" ${REPORT_CLOSE_ATTR} class="reticle-report-close" title="Close" aria-label="Close impact">${close}</button>
      </div>
      <div class="reticle-report-body" data-reticle-report-body></div>
      <div class="reticle-report-foot">
        <button type="button" ${SHARE_X_ATTR} class="reticle-report-share">Post on X</button>
        <button type="button" ${SHARE_IN_ATTR} class="reticle-report-share">LinkedIn</button>
        <button type="button" ${SHARE_COPY_ATTR} class="reticle-report-share">${REPORT_TEXT.COPY}</button>
        <button type="button" ${REFER_ATTR} class="reticle-report-share reticle-report-refer">${REPORT_TEXT.REFER}</button>
      </div>
      <div class="reticle-report-links">
        <a href="${REPORT_LINKS.DOCS}" target="_blank" rel="noreferrer noopener">Docs</a>
        <a href="${REPORT_LINKS.GITHUB}" target="_blank" rel="noreferrer noopener">GitHub</a>
        <a href="${REPORT_LINKS.SITE}" target="_blank" rel="noreferrer noopener">reticle.sh</a>
        <a href="${REPORT_LINKS.DISCORD}" target="_blank" rel="noreferrer noopener">Discord</a>
      </div>
    </div>
  </div>`;
}

/** A stat card: the number, what it is, and - for an estimate - what it is measured against. */
function card(value: string, label: string, basis?: string): string {
  const tag =
    basis === undefined
      ? ''
      : `<span class="reticle-report-basis" title="${basis}">${REPORT_TEXT.ESTIMATE_TAG}</span>`;
  return `<div class="reticle-report-card"><span class="reticle-report-value">${value}</span><span class="reticle-report-label">${label}${tag}</span></div>`;
}

/**
 * A 30-day bar chart of verdicts, as inline spans.
 *
 * Bars rather than a line: a day with no verdicts is a real fact about the week, and a line chart
 * interpolates straight through it.
 */
function chart(scope: ImpactScope): string {
  const days = scope.days.slice(-30);
  if (0 === days.length) return '';
  const peak = Math.max(1, ...days.map((d) => d.counts.verdicts));
  const bars = days
    .map((d) => {
      const pct = Math.max(4, Math.round((d.counts.verdicts / peak) * 100));
      const title = `${d.date}: ${String(d.counts.verdicts)} verdicts, ${String(d.counts.failed)} defects`;
      const hot = d.counts.failed > 0 ? ' data-hot="1"' : '';
      return `<span class="reticle-report-bar" style="height:${String(pct)}%" title="${title}"${hot}></span>`;
    })
    .join('');
  return `<div class="reticle-report-chart-wrap"><span class="reticle-report-section">${REPORT_TEXT.CHART}</span><div class="reticle-report-chart">${bars}</div></div>`;
}

export function reportBodyHtml(scope: ImpactScope): string {
  const c = scope.counts;
  if (0 === c.calls) return `<p class="reticle-report-empty">${REPORT_TEXT.EMPTY}</p>`;
  const streak =
    scope.records.streakDays > 0
      ? `<span class="reticle-report-streak" title="Consecutive days with at least one verdict">🔥 ${String(scope.records.streakDays)} <span class="reticle-report-streak-label">${REPORT_TEXT.STREAK}</span></span>`
      : '';
  const hero = `<div class="reticle-report-hero"><span class="reticle-report-hero-value">${compactNumber(c.failed)}</span><span class="reticle-report-hero-label">${REPORT_TEXT.HERO_DEFECTS}</span></div>`;
  const verdicts = `<div class="reticle-report-verdicts" title="${REPORT_TEXT.UNKNOWN_HELP}">
    <span class="reticle-report-verdict" data-kind="pass">${compactNumber(c.passed)} ${REPORT_TEXT.PASSED}</span>
    <span class="reticle-report-verdict" data-kind="fail">${compactNumber(c.failed)} ${REPORT_TEXT.FAILED}</span>
    <span class="reticle-report-verdict" data-kind="unknown">${compactNumber(c.unknown)} ${REPORT_TEXT.UNKNOWN}</span>
  </div>`;
  const cards = [
    card(compactNumber(c.verdicts), REPORT_TEXT.VERDICTS),
    card(compactNumber(c.calls), REPORT_TEXT.CALLS),
    card(compactDuration(c.drivingMs), REPORT_TEXT.DRIVING),
    card(compactNumber(c.sessions), REPORT_TEXT.SESSIONS),
    card(compactDuration(scope.records.longestRunMs), REPORT_TEXT.LONGEST),
    card(compactNumber(c.tokensReturned), REPORT_TEXT.TOKENS),
    card(
      compactNumber(scope.savings.tokens.value),
      REPORT_TEXT.SAVED_TOKENS,
      scope.savings.tokens.basis,
    ),
    card(
      compactDuration(scope.savings.minutes.value * 60_000),
      REPORT_TEXT.SAVED_MINUTES,
      scope.savings.minutes.basis,
    ),
  ].join('');
  return `${streak}${hero}${verdicts}<div class="reticle-report-grid">${cards}</div>${chart(scope)}`;
}

export interface ReportHost {
  /** Opened from the toolbar and from the chat, so the shell decides what else must close. */
  onBeforeOpen?: () => void;
}

/** The report panel controller: scope toggle, live repaint, share + referral actions. */
export class PresenterReport {
  #panel: HTMLElement | undefined;
  #body: HTMLElement | undefined;
  #root: HTMLElement | undefined;
  #snapshot: ImpactSnapshot | undefined;
  #global = false;
  readonly #host: ReportHost;

  constructor(host: ReportHost = {}) {
    this.#host = host;
  }

  mount(root: HTMLElement): void {
    this.#root = root;
    this.#panel = root.querySelector<HTMLElement>(`[${REPORT_PANEL_ATTR}]`) ?? undefined;
    this.#body = root.querySelector<HTMLElement>('[data-reticle-report-body]') ?? undefined;
    root.querySelector(`[${REPORT_CLOSE_ATTR}]`)?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.close();
    });
    const scopeBtn = root.querySelector(`[${SCOPE_ATTR}]`);
    scopeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.#global = !this.#global;
      scopeBtn.setAttribute('aria-pressed', this.#global ? 'true' : 'false');
      scopeBtn.textContent = this.#global ? REPORT_TEXT.GLOBAL : REPORT_TEXT.PROJECT;
      this.#paint();
    });
    root.querySelector(`[${SHARE_X_ATTR}]`)?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.#openShare(buildXShareUrl(this.shareText()));
    });
    root.querySelector(`[${SHARE_IN_ATTR}]`)?.addEventListener('click', (e) => {
      e.stopPropagation();
      // LinkedIn ignores every text parameter, so the caption goes to the clipboard first and the
      // composer opens on the link - the only route that needs no posting permission.
      void this.#copy(this.shareText());
      this.#openShare(buildLinkedInShareUrl());
    });
    root.querySelector(`[${SHARE_COPY_ATTR}]`)?.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.#copy(this.shareText(), e.currentTarget);
    });
    root.querySelector(`[${REFER_ATTR}]`)?.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.#copy(buildReferralText(), e.currentTarget);
    });
  }

  /** The record arrived from the daemon. Repaint only if the panel is on screen. */
  setSnapshot(snapshot: ImpactSnapshot): void {
    this.#snapshot = snapshot;
    if (this.isOpen()) this.#paint();
  }

  snapshot(): ImpactSnapshot | undefined {
    return this.#snapshot;
  }

  isOpen(): boolean {
    return '1' === this.#root?.getAttribute(REPORT_ATTR);
  }

  open(): void {
    if (this.#root === undefined) return;
    this.#host.onBeforeOpen?.();
    this.#paint();
    this.#root.setAttribute(REPORT_ATTR, '1');
    this.#panel?.setAttribute('aria-hidden', 'false');
  }

  close(): void {
    this.#root?.setAttribute(REPORT_ATTR, '0');
    this.#panel?.setAttribute('aria-hidden', 'true');
  }

  toggle(): void {
    if (this.isOpen()) this.close();
    else this.open();
  }

  contains(node: Node): boolean {
    return true === this.#panel?.contains(node);
  }

  /** The post text for whichever scope is showing. */
  shareText(): string {
    const snap = this.#snapshot;
    if (snap === undefined) return buildReferralText();
    return this.#global
      ? buildShareText(snap.global)
      : buildShareText(snap.project, snap.projectName);
  }

  #scope(): ImpactScope | undefined {
    const snap = this.#snapshot;
    if (snap === undefined) return undefined;
    return this.#global ? snap.global : snap.project;
  }

  #paint(): void {
    const scope = this.#scope();
    if (this.#body === undefined) return;
    this.#body.innerHTML =
      scope === undefined
        ? `<p class="reticle-report-empty">${REPORT_TEXT.EMPTY}</p>`
        : reportBodyHtml(scope);
  }

  #openShare(url: string): void {
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  async #copy(text: string, button?: EventTarget | null): Promise<void> {
    try {
      await navigator.clipboard?.writeText(text);
    } catch {
      // A blocked clipboard is not worth an error dialog over; the text is on screen either way.
    }
    if (button instanceof HTMLElement) {
      const original = button.textContent ?? '';
      button.textContent = REPORT_TEXT.COPIED;
      window.setTimeout(() => {
        button.textContent = original;
      }, COPIED_FLASH_MS);
    }
  }
}
