/**
 * WHY a lease came back `ready: false` — the two situations that were one word.
 *
 * Split out of `constants.ts` when the full-text bounds on `TRANSPORT_LIMITS` took that file past
 * its line cap. `ready: false` meant exactly one thing on the mint path: the SDK never dialled in,
 * so the app probably does not embed `@reticlehq/core`. A REUSED lease can fail readiness a second
 * way, and it is the opposite problem: an SDK did dial in, and has since stopped answering. The
 * next action differs — check the install versus recover the tab — so the two get names rather
 * than sharing a bare `false`.
 */
export const LeaseNotReadyReason = {
  /** No SDK dialled in within the wait. The install is the thing to look at. */
  SDK_NEVER_DIALLED: 'sdk_never_dialled',
  /** One dialled in and stopped answering: the tab is attached but wedged. */
  SDK_STOPPED_ANSWERING: 'sdk_stopped_answering',
} as const;
export type LeaseNotReadyReason = (typeof LeaseNotReadyReason)[keyof typeof LeaseNotReadyReason];
