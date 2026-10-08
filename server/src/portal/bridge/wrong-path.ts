/**
 * A browser that dials the bridge on the wrong path (#1242).
 *
 * `connect()` adds the bridge path to a URL with none (#1342), but a URL with any other explicit
 * path, `ws://localhost:4400/ws` for one, reaches the daemon and `ws` answers it with a bare 400
 * from its own path check. `verifyClient` never runs, so unlike an origin refusal nothing was
 * recorded, and the no-session diagnosis listed its usual causes without the one that applied.
 */
import type { IncomingMessage } from 'node:http';
import type { WebSocketServer } from 'ws';
import { RETICLE_WS_PATH } from '@reticlehq/core';

/** Long enough for any real path, short enough that a junk request cannot fill the log line. */
const MAX_PATH_SHOWN = 80;

/** The path an upgrade asked for: the pathname only, because a query can carry a pairing token. */
export function requestedPath(url: string | undefined): string {
  const path = (url ?? '').split('?', 1)[0] ?? '';
  const shown = 0 === path.length ? '/' : path;
  return shown.length > MAX_PATH_SHOWN ? `${shown.slice(0, MAX_PATH_SHOWN)}…` : shown;
}

/** What the no-session diagnosis says about it. The path is in it because the path is the fix. */
export function wrongPathReason(path: string, origin: string | undefined): string {
  const from = origin === undefined || 0 === origin.length ? 'a client' : `a page on ${origin}`;
  return (
    `${from} dialled this daemon on ${path} and got a 400: the bridge listens on ` +
    `${RETICLE_WS_PATH} only. Point the URL given to connect({ url }) at the bridge path, for ` +
    `example ws://localhost:<port>${RETICLE_WS_PATH}. The app is running and instrumented, it ` +
    'dialled the wrong path, so do not go looking for a stopped dev server.'
  );
}

/**
 * Report each upgrade `ws` turns away for its path. Wraps `shouldHandle`, which `ws` documents as
 * the method to override and calls for every upgrade before it answers 400, so the decision itself
 * is left to `ws` and only observed here.
 */
export function noteWrongPathUpgrades(
  wss: WebSocketServer,
  note: (path: string, origin: string | undefined) => void,
): void {
  const handles = wss.shouldHandle.bind(wss);
  wss.shouldHandle = (req: IncomingMessage): boolean | Promise<boolean> => {
    const handled = handles(req);
    if (false === handled) note(requestedPath(req.url), req.headers.origin);
    return handled;
  };
}
