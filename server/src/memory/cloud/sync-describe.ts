/**
 * What a sync cycle says about itself: one line for the CLI and the daemon log, and the failure a
 * person reads in `reticle whoami`. Kept beside the cycle, apart from it, because the cycle is the
 * protocol and this is only how it is reported.
 */
import type { SyncReport } from './sync-cycle.js';

/**
 * Say WHICH host failed and WHY.
 *
 * Node's fetch rejects with the bare string "fetch failed" and hides the real reason — a refused
 * connection, a bad hostname, an expired certificate — one level down in `cause`. A machine that
 * has quietly stopped syncing shows that string in `reticle whoami`, and on its own it is
 * indistinguishable from every other network problem, so the person reading it learns nothing and
 * checks nothing. Naming the origin and the underlying code turns it into one thing to look at.
 */
export function describeTransportError(error: unknown, url: string): string {
  if (!(error instanceof Error)) return String(error);
  const cause: unknown = (error as { cause?: unknown }).cause;
  if (!(cause instanceof Error)) return `${error.message} (${url})`;
  const code = (cause as { code?: unknown }).code;
  // The code and the message are each sometimes empty — an aggregate DNS failure carries a code and
  // no text, a TLS failure the reverse. Joined only when both are there, so the line never trails
  // off into a dangling separator.
  const parts = ['string' === typeof code && code.length > 0 ? code : '', cause.message].filter(
    (part) => part.length > 0,
  );
  const detail = parts.join(': ');
  return 0 === detail.length
    ? `${error.message} (${url})`
    : `${error.message} — ${detail} (${url})`;
}

/** One line a human can read, for the CLI and the daemon log. */
export function describeSync(report: SyncReport): string {
  if (report.error !== undefined) return `sync failed — ${report.error}`;
  const sent: string[] = [];
  if (report.runsSent > 0) sent.push(`${String(report.runsSent)} run(s)`);
  if (report.flowsSent > 0) sent.push(`${String(report.flowsSent)} flow(s)`);
  if (report.capsulesSent > 0) sent.push(`${String(report.capsulesSent)} capsule(s)`);
  if ((report.screenshotsSent ?? 0) > 0)
    sent.push(`${String(report.screenshotsSent)} screenshot(s)`);
  if (report.derivedSent.length > 0) sent.push(report.derivedSent.join(', '));
  /*
   * "Nothing to send" is a statement about the QUEUE, and it is false the moment the queue was full
   * and the server threw it away. Built from what was accepted, the sentence used to read "nothing
   * to send, 3 rejected" — something was very much sent, and the reader is told both that it was
   * not and nothing about why.
   */
  const rejectedCount = report.runsRejected.length + report.refused.length;
  const push =
    sent.length > 0
      ? `sent ${sent.join(' + ')}`
      : rejectedCount > 0
        ? 'nothing accepted'
        : true === report.localIsEmpty
          ? // Not the same statement as "nothing to send", which describes a repo that is simply up
            // to date. This one has never recorded anything, which for a LINKED repo usually means
            // the app announces no projectId and its runs are landing under a different root.
            'nothing recorded here yet — if this app has been driven, it is reporting somewhere else'
          : 'nothing to send';
  const pull =
    0 === report.pulled
      ? ''
      : `, pulled ${String(report.pulled)} decision(s)${report.morePending ? ' (more waiting)' : ''}`;
  return `${push}${pull}${problemsOf(report)
    .map((problem) => `, ${problem}`)
    .join('')}`;
}

/**
 * What went wrong, one phrase per kind of problem.
 *
 * One reason, not a count. A rejection count tells somebody they have a problem and nothing about
 * which problem — and these arrive from a BACKGROUND daemon, so the summary line is often the only
 * place anybody ever sees it. Rejections in one cycle almost always share a cause (a version skew
 * refuses every payload the same way), so the first reason plus the count is the whole story
 * without printing a line per item; `reticle sync` still lists them all.
 */
export function problemsOf(report: SyncReport): string[] {
  const problems: string[] = [];
  const count = report.runsRejected.length + report.refused.length;
  if (count > 0) {
    const first = report.runsRejected[0]?.reason ?? report.refused[0]?.reason ?? 'no reason given';
    problems.push(`${String(count)} rejected — ${first}`);
  }
  const firstRefusal = report.notRetried[0];
  if (firstRefusal !== undefined)
    problems.push(
      `refused, not retried: ${String(report.notRetried.length)} run(s) (${firstRefusal.reason})`,
    );
  for (const set of report.setsNotRetried)
    problems.push(`refused, not retried: ${String(set.count)} ${set.part}(s) (${set.reason})`);
  if (report.held.length > 0) problems.push(`not sent: ${report.held.join('; ')}`);
  const copies = report.flowConflicts ?? [];
  if (copies.length > 0)
    problems.push(
      `${String(copies.length)} flow conflict(s): another machine saved first, so this edit is kept as ${copies.join(', ')}; merge or delete it`,
    );
  return problems;
}
