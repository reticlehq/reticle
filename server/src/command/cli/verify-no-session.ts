const MSG_NO_SESSION =
  'No app connected: Reticle drove the URL but no @reticlehq/browser session dialed back.\n' +
  '  Make sure the SDK is in the build and reticle.connect() runs on the preview page' +
  ' (for a non-localhost preview: allowNonLocalhost + a pairing token).';

/** A `--timeout` under this is likely a count of seconds, so the message names the unit. */
const SHORT_TIMEOUT_MS = 1000;

/** Why no session connected. A short timeout also says that the unit is milliseconds. */
export function noSessionMessage(timeoutMs: number): string {
  if (timeoutMs >= SHORT_TIMEOUT_MS) {
    return MSG_NO_SESSION;
  }
  return (
    `${MSG_NO_SESSION}\n  The wait was ${String(timeoutMs)} ms: the timeout is in milliseconds. ` +
    'Use --timeout 60000 to wait 60 seconds.'
  );
}
