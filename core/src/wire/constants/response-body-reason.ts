/**
 * Why a NET_REQUEST's `responseBody` is absent, or present when the app never asked for bodies.
 *
 * `ERROR_STATUS` marks a body recorded only because the call failed. The other three mark a body
 * the SDK skipped ON PURPOSE while body capture was on (#1520). Without them, a skipped body looked
 * like capture switched off, so a body clause answered `no` and told the caller to enable a setting
 * that was already on. No reason on a body-less call means capture was off, or the SDK predates this.
 */
export const ResponseBodyReason = {
  /** Recorded only because the response was an error; the app did not ask for bodies. */
  ERROR_STATUS: 'error-status',
  /** A stream (`text/event-stream`, ndjson): never read, because reading it would hang the app. */
  STREAMING: 'streaming',
  /** A binary or other non-text type, which is not recorded. */
  NOT_TEXT: 'not-text',
  /** A text body that could not be read before the read deadline, or at all. */
  UNREADABLE: 'unreadable',
} as const;
export type ResponseBodyReason = (typeof ResponseBodyReason)[keyof typeof ResponseBodyReason];
