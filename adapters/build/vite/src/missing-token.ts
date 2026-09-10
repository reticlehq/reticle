/**
 * The one build-time condition that guarantees a runtime failure.
 *
 * The pairing token is read from disk ONCE, when Vite resolves its config, and inlined as
 * `__RETICLE_TOKEN__`. The daemon is what writes that file — so a dev server started BEFORE the
 * daemon bakes in an empty token, and every app it serves opens a WebSocket the bridge then refuses.
 *
 * Nothing about that looks broken from outside: the SDK module loads, the socket opens, and then a
 * session simply never appears. Restarting the dev server is the whole fix, and no other layer is in
 * a position to say so — by the time the failure is observable, the value was baked in minutes ago.
 */

export function missingTokenWarning(token: string | undefined): string | undefined {
  if (token !== undefined && token.length > 0) return undefined;
  return (
    '[reticle] no pairing token was available when this dev server started, so the app will connect ' +
    'and be refused — you will see NO SESSION even though the SDK loads and the socket opens. ' +
    'The token is written by the Reticle daemon: start it (`reticle serve`, or let your agent start ' +
    'it) and then RESTART this dev server, because the value is inlined at config time.'
  );
}
