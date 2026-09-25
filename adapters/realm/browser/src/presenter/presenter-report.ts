import {
  IMPACT_DEFECT_LIMIT,
  type AccountState,
  type ImpactScope,
  type ImpactSnapshot,
} from '@reticlehq/core';
import { PresenterIcon, PRESENTER_ICON_SIZE, hiIconHtml } from './icons/presenter-icons.js';
import { HUD_SURFACE_CLASS } from './chrome/presenter-hud-chrome.js';
import { esc, isSafeDashboardUrl } from './chrome/presenter-safe-html.js';
import {
  ACCOUNT_SIGNIN_ATTR,
  ACCOUNT_TEXT,
  SYNC_BTN_ATTR,
  accountControlHtml,
  syncButtonHtml,
} from './presenter-account.js';
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
} from './chrome/presenter-report-copy.js';

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
  return `<div ${REPORT_PANEL_ATTR} class="reticle-report ${HUD_SURFACE_CLASS}" role="region" aria-label="Reticle impact" aria-hidden="true">
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
        <a data-reticle-link="docs" href="${REPORT_LINKS.DOCS}" target="_blank" rel="noreferrer noopener">Docs</a>
        <a data-reticle-link="github" href="${REPORT_LINKS.GITHUB}" target="_blank" rel="noreferrer noopener">GitHub</a>
        <a data-reticle-link="site" href="${REPORT_LINKS.SITE}" target="_blank" rel="noreferrer noopener">reticle.sh</a>
        <a data-reticle-link="discord" href="${REPORT_LINKS.DISCORD}" target="_blank" rel="noreferrer noopener">Discord</a>
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

/**
 * Escape text that came from the app under test.
 *
 * A defect title is an element's accessible name or a verdict's failure reason — both of which are
 * ultimately the CONTENT of somebody else's page. Moved to `chrome/presenter-safe-html.ts` when the
 * account capsule became a second caller — see there for the rule and why it is not copied.
 */

/**
 * The short list of what is currently broken.
 *
 * The hero number already says HOW MANY defects Reticle caught; this says WHICH ONES, which is the
 * difference between a statistic and something a person can act on. Deliberately short: a panel in
 * the corner of somebody's app is not a triage queue, and the link at the bottom is where the queue
 * lives. When the project is not linked to a workspace there is no link and no nagging — the free
 * tool is complete on its own.
 */
/**
 * Whether a dashboard link is safe to render as a clickable href.
 *
 * Moved to `chrome/presenter-safe-html.ts` with `esc`, for the same reason: the `javascript:` scheme
 * incident is recorded there, and a security rule living in two files gets fixed in one of them.
 */

function defects(scope: ImpactScope, dashboardUrl: string | undefined): string {
  /*
   * Defaulted here as well as in the schema. Zod's default applies when a record is PARSED, and the
   * snapshot reaching this panel is pushed straight from the daemon rather than round-tripped
   * through the schema — so a record written by an older build arrives with no `defects` field at
   * all, and an unguarded read throws, taking the whole report down with it.
   */
  const list = (scope.defects ?? []).slice(0, IMPACT_DEFECT_LIMIT);
  if (0 === list.length) return '';
  /*
   * The way through, per row — but only for a project that is actually linked.
   *
   * An icon leading somewhere the user has no account for is an advert on a row about their own
   * broken app, which is the worst possible moment for one. It is the DASHBOARD's icon rather than
   * GitHub's: a GitHub mark promises "this files a GitHub issue", and the link goes to the
   * dashboard, which is where pushing to a tracker is managed. The copy carries what the icon
   * cannot.
   */
  const linked = dashboardUrl !== undefined && isSafeDashboardUrl(dashboardUrl);
  const rowLink = linked
    ? `<a class="reticle-report-defect-link" data-reticle-link="defect" href="${esc(dashboardUrl)}" target="_blank" rel="noreferrer noopener" title="${REPORT_TEXT.DEFECT_LINK_TITLE}" aria-label="${REPORT_TEXT.DEFECT_LINK_TITLE}">${hiIconHtml(PresenterIcon.VIEW, PRESENTER_ICON_SIZE.SEND)}</a>`
    : '';
  const rows = list
    .map((d) => {
      const detail =
        d.detail === undefined
          ? ''
          : `<span class="reticle-report-defect-detail">${esc(d.detail)}</span>`;
      const source =
        d.source === undefined
          ? ''
          : `<span class="reticle-report-defect-source">${esc(d.source)}</span>`;
      return `<li class="reticle-report-defect"><span class="reticle-report-defect-title">${esc(d.title)}</span>${detail}${source}${rowLink}</li>`;
    })
    .join('');
  // Only claim there are more when there actually are — `counts.failed` is every defect ever, and
  // this list is the recent tail of it.
  const more = !linked
    ? ''
    : `<a class="reticle-report-defects-more" data-reticle-link="dashboard" href="${esc(dashboardUrl)}" target="_blank" rel="noreferrer noopener">${REPORT_TEXT.DEFECTS_MORE}${scope.counts.failed > list.length ? ` (${String(scope.counts.failed)})` : ''}</a>`;
  /*
   * The push control, beside the heading of the section it pushes.
   *
   * It is the SAME button as the one in the identity row, delegated to the same handler — the
   * listener matches on `closest`, so a second instance costs no wiring. What it buys is where it
   * is: next to the account name it reads as "sync my account", and somebody looking at a list of
   * their own broken things had no way to tell that those rows were the thing being sent.
   *
   * `syncButtonHtml` returns nothing for an unlinked project, which is the same rule the row links
   * follow: with nowhere to push, a button that acknowledges a press having sent nothing is a false
   * green on our own HUD.
   */
  const sync = syncButtonHtml(dashboardUrl);
  return `<div class="reticle-report-defects-wrap"><div class="reticle-report-defects-head"><span class="reticle-report-section">${REPORT_TEXT.DEFECTS}</span>${sync}</div><ul class="reticle-report-defects">${rows}</ul>${more}</div>`;
}

export function reportBodyHtml(
  scope: ImpactScope,
  dashboardUrl?: string,
  account?: AccountState,
  projectName?: string,
): string {
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
  /*
   * Who this record belongs to, and the way to push it now — at the TOP, above the numbers.
   *
   * The `localOnly` line at the foot answers the same question for somebody who has nothing set up
   * yet, and it stays there: it is a sentence explaining a next step, which belongs after the thing
   * it is about. This is a control, and a control somebody has to scroll a panel to find is one they
   * will not find. The two never both render — `localOnly` is gated on there being NO dashboard.
   */
  const identity = `<div class="reticle-report-identity">${accountControlHtml(account, { dashboardUrl, projectName, verdicts: c.verdicts, defects: c.failed })}${syncButtonHtml(dashboardUrl)}</div>`;
  return `${identity}${streak}${hero}${verdicts}<div class="reticle-report-grid">${cards}</div>${defects(scope, dashboardUrl)}${chart(scope)}${localOnly(scope, dashboardUrl, account)}`;
}

/**
 * The one line about where this record lives, and what the next step is — if there is one.
 *
 * NOT gated on `dashboardUrl` alone, which conflates two states with opposite remedies: "nobody on
 * this machine has signed in" (`reticle login`) and "signed in, but this repo is not linked"
 * (`reticle link`). Telling a signed-in user to sign in is the kind of nag that gets a dev-only HUD
 * switched off for good.
 *
 * An ABSENT `account` is unknown, never signed-out. An older daemon sends none, and guessing there
 * would prompt a paying user on every panel they open. Silence is the only safe reading.
 *
 * Gated on a VERDICT, not on tool calls. Somebody who has driven the app but proved nothing has not
 * yet received the thing this offers to preserve, and offering to keep nothing is an advert. Past
 * that bar it is a fact about where their record lives, at the foot of a panel they opened on
 * purpose — which is why it does not need to be dismissible.
 */
function localOnly(
  scope: ImpactScope,
  dashboardUrl: string | undefined,
  account: AccountState | undefined,
): string {
  if (dashboardUrl !== undefined) return '';
  if (scope.counts.verdicts <= 0) return '';
  if (account === undefined) return '';
  const [lead, action, tail] = account.signedIn
    ? [REPORT_TEXT.UNLINKED, REPORT_TEXT.UNLINKED_ACTION, REPORT_TEXT.UNLINKED_TAIL]
    : [REPORT_TEXT.LOCAL_ONLY, REPORT_TEXT.LOCAL_ONLY_ACTION, REPORT_TEXT.LOCAL_ONLY_TAIL];
  return `<p class="reticle-report-local-only">${lead} <code>${action}</code> ${tail}</p>`;
}

interface ReportHost {
  /** Opened from the toolbar and from the chat, so the shell decides what else must close. */
  onBeforeOpen?: () => void;
  /**
   * The panel's sync button was pressed. The shell owns the socket, so it sends; this panel only
   * knows that somebody asked.
   */
  onSyncNow?: () => void;
}

/** How long the sync control acknowledges a press. See the note at its click handler. */
const SYNC_SPIN_MS = 1_200;
const SYNCING_ATTR = 'data-syncing';

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
    /*
     * The identity controls are DELEGATED, unlike every binding above.
     *
     * They live in the panel BODY, which is replaced wholesale on every repaint — and a repaint
     * happens on each snapshot push, which is roughly whenever anything interesting occurs. A
     * listener bound to the element itself would work until the first push and then silently stop,
     * which is the worst shape of broken: it demos perfectly.
     */
    root.addEventListener('click', (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const signin = target.closest(`[${ACCOUNT_SIGNIN_ATTR}]`);
      if (signin !== null) {
        e.stopPropagation();
        // The command, not a sign-in. A page cannot run a CLI, and a button that quietly does
        // nothing is worse than a line of text because the person waits for it.
        void this.#copy(ACCOUNT_TEXT.SIGNIN_COMMAND, signin);
        return;
      }
      const sync = target.closest(`[${SYNC_BTN_ATTR}]`);
      if (sync !== null) {
        e.stopPropagation();
        this.#host.onSyncNow?.();
        /*
         * The spinner says ASKED, not DONE, and stops on a timer rather than on a result.
         *
         * Nothing reports completion back to this page — the cycle happens in the daemon, and the
         * only thing that returns is a fresh snapshot, which arrives whether or not anything was
         * pushed. Spinning until "done" would therefore mean spinning until something unrelated
         * happened, and a control that claims success it cannot observe is the false green this
         * product refuses everywhere else. So it acknowledges the press and gets out of the way.
         */
        sync.setAttribute(SYNCING_ATTR, '1');
        setTimeout(() => sync.removeAttribute(SYNCING_ATTR), SYNC_SPIN_MS);
      }
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
        : reportBodyHtml(
            scope,
            this.#snapshot?.dashboardUrl,
            this.#snapshot?.account,
            this.#snapshot?.projectName,
          );
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
