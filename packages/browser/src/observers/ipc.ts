import {
  BlindSpotKind,
  EventType,
  IPC_URL_SCHEME,
  IpcStatus,
  NetInitiator,
  RETICLE_IPC_GLOBAL,
  RETICLE_TAURI_CAPTURE_COMMAND,
} from '@reticlehq/core';
import type { Emit, Teardown } from './types.js';
import { observeSafely } from './types.js';

/**
 * IPC observer — the desktop counterpart to the network observer.
 *
 * An Electron or Tauri app does not reach its backend over HTTP: it calls into the main process /
 * Rust core over IPC. Left unobserved, every backend call in a desktop app is a blind spot:
 * `reticle_network` reports nothing, `act_and_wait` has no in-flight request to settle on, and
 * `assert { net }` is vacuously true — a false green by construction.
 *
 * Observed calls are reported as the SAME pair the network observer emits (NET_PENDING at call time,
 * NET_REQUEST at resolution) with `initiator: 'ipc'` and the channel name as an `ipc://` url, so the
 * existing tools, oracles and settle logic work on desktop unchanged. No new wire contract.
 *
 * NEITHER runtime can be instrumented by patching what the page can see — both harden their IPC
 * entry point, which is why this file contains two mechanisms and no direct monkey-patching:
 *
 *  - **Electron**: `contextBridge.exposeInMainWorld` hands the renderer a deeply frozen,
 *    non-configurable object. Calls are observed in the PRELOAD, by
 *    `@reticlehq/electron/preload`, and pushed to the channel this file subscribes to.
 *  - **Tauri v2**: `__TAURI_INTERNALS__.invoke` is `writable: false, configurable: false`. It does
 *    not need patching — an `invoke` travels as a real `fetch` to Tauri's `ipc://` custom protocol,
 *    which the network observer already sees. See `ipcNetOverrides`.
 */

/** One report from the preload shim: a call starting, or the same call settling. */
interface PreloadRecord {
  phase: 'start' | 'end';
  id: string;
  channel: string;
  ok?: boolean;
  durationMs?: number;
  error?: string;
  /**
   * A fire-and-forget `ipcRenderer.send`: dispatched, with no outcome the renderer can ever learn.
   * Such a record carries NO `ok` and NO `status` — see the emit below.
   */
  oneWay?: boolean;
  /**
   * The call's payloads, as the preload serialized them. A desktop app's whole API surface is IPC,
   * so without these every payload-based check — a batch whose ok envelope hides per-item failures,
   * a money value written back at the wrong scale — is web-only on Electron.
   */
  requestBody?: string;
  requestSize?: number;
  responseBody?: string;
  responseSize?: number;
  responseBodyTruncated?: boolean;
}

interface PreloadChannel {
  /** Returns a token identifying this subscription (-1 if the callback was rejected). */
  subscribe: (callback: (record: PreloadRecord) => void) => number;
  /** Real removal. Older preloads predate this, so it is optional and absence is tolerated. */
  unsubscribe?: (token: number) => void;
}

/**
 * How Tauri v2 reports a command's verdict. The transport answers HTTP 200 whether the Rust command
 * returned Ok or Err — the verdict is in this response header, which Tauri explicitly CORS-exposes so
 * JS may read it. Without translating it, every failed command is recorded as a successful request.
 */
const TAURI_RESPONSE_HEADER_NAME = 'Tauri-Response';
const TAURI_RESPONSE_ERROR = 'error';

/** Rust/IPC vocabulary rather than HTTP's, so the text never claims a transport status it lacks. */
const IPC_STATUS_TEXT = { OK: 'Ok', ERROR: 'Err' } as const;

/**
 * Tauri's IPC endpoint. The last path segment is the command name.
 *
 * TWO spellings, because Tauri v2 uses a different one per platform and matching only the first is a
 * silent false green on Windows: macOS/Linux get the custom scheme `ipc://localhost/archive_todo`,
 * while Windows (and Android) need a real http origin and get
 * `http://ipc.localhost/archive_todo` — the hostname `desktop-doctor` already tells people to put in
 * their CSP. Unmatched, a Windows `invoke` was recorded as an ordinary HTTP request, so the
 * `Tauri-Response` translation never ran and every command that returned `Err` was banked as a
 * successful 200. `.localhost` is reserved for loopback by RFC 6761, so this can never match a
 * remote host.
 */
const TAURI_IPC_URL = /^(?:ipc:\/\/[^/]*|https?:\/\/ipc\.localhost(?::\d+)?)\/(.+)$/;

/**
 * Fields to override on a NET_REQUEST that turned out to be a Tauri IPC call, or null when the
 * request was ordinary HTTP. Pure — the network observer calls this with the response header it
 * already holds, so IPC knowledge stays in this file.
 */
export function ipcNetOverrides(
  url: string,
  header: (name: string) => string | null,
): Record<string, unknown> | undefined {
  const match = TAURI_IPC_URL.exec(url);
  const command = match?.[1];
  if (command === undefined) return undefined;
  const ok = header(TAURI_RESPONSE_HEADER_NAME) !== TAURI_RESPONSE_ERROR;
  return {
    // Normalize `ipc://localhost/archive_todo` to `ipc://archive_todo`, so a Tauri command and an
    // Electron channel read identically to the agent and to a saved flow's assertions.
    url: `${IPC_URL_SCHEME}${command}`,
    initiator: NetInitiator.IPC,
    method: NetInitiator.IPC,
    ok,
    status: ok ? IpcStatus.OK : IpcStatus.ERROR,
    // Overwrite the TRANSPORT's statusText. Tauri's fetch genuinely answered 200/"OK", so letting it
    // through beside a synthetic 500 produced a record that contradicted itself — `status: 500,
    // statusText: "OK"` reads as nonsense to anyone seeing it cold. The record must tell one story,
    // and the story that matters is the command's verdict, not the pipe it travelled down.
    statusText: ok ? IPC_STATUS_TEXT.OK : IPC_STATUS_TEXT.ERROR,
  };
}

/**
 * Is this fetch Reticle's OWN desktop call rather than the app's?
 *
 * Tauri has no preload stage, so `reticle_screenshot` reaches the shell the only way it can: an
 * `invoke` — and an invoke IS a fetch to the `ipc://` protocol, straight through the patch the
 * network observer installed. So the observer recorded its own screenshots as app IPC calls, and
 * because `IPC` counts as a mutating method, three concurrent captures inside one action window came
 * back to the agent as `duplicate-request`: "the same write fired 3 times", against an app that had
 * never made the call. Accusing a correct app of a double submit is the most damaging thing a
 * verification tool can do, and here the tool was the one submitting.
 *
 * Electron never had this problem — its preload captures through the UNPATCHED invoke for exactly
 * this reason — and the bridge's own WebSocket is skipped on the same principle (`isBridgeSocket`).
 * The capture command is the SDK's whole Tauri-side surface, so matching it is the whole rule.
 */
export function isReticleOwnIpc(url: string): boolean {
  return TAURI_IPC_URL.exec(url)?.[1] === RETICLE_TAURI_CAPTURE_COMMAND;
}

/**
 * Is this page an Electron renderer? Read off the user agent, which Electron stamps and which is
 * available whether or not the preload ran — the whole point is to recognise a renderer that has
 * NOT been instrumented.
 */
function isElectronRenderer(): boolean {
  return navigator.userAgent.includes('Electron');
}

/**
 * Subscribe to the Electron preload shim, if this app installed it. Inert on Tauri (whose calls the
 * network observer handles) and on a plain web page.
 */
interface IpcOptions {
  /** Forward the IPC payloads the preload recorded. Off by default, like the HTTP body capture. */
  captureBodies?: boolean;
}

export function installIpc(emit: Emit, options: IpcOptions = {}): Teardown {
  const channel = (window as unknown as Record<string, unknown>)[RETICLE_IPC_GLOBAL] as
    PreloadChannel | undefined;
  if (typeof channel?.subscribe !== 'function') {
    // No shim — but on Electron that is not "nothing to observe", it is "everything unobserved".
    // Tauri needs no shim (its invoke travels as a fetch) and a web page has no IPC at all, so only
    // Electron gets the declaration. Saying nothing here is what let a missing preload line read as
    // a clean, empty network view for a whole app.
    if (isElectronRenderer())
      emit(EventType.BLIND_SPOT, { kind: BlindSpotKind.UNOBSERVED_IPC, count: 1 });
    return () => undefined;
  }

  const token = channel.subscribe((record) => {
    observeSafely(() => {
      const url = `${IPC_URL_SCHEME}${record.channel}`;
      if ('start' === record.phase) {
        emit(EventType.NET_PENDING, {
          id: record.id,
          method: NetInitiator.IPC,
          url,
          initiator: NetInitiator.IPC,
        });
        return;
      }
      // A one-way `send` that did not throw has NO verdict — the renderer never learns whether the
      // main process handled it. Emitting `ok/status` anyway would manufacture the success nobody
      // reported, so both are omitted and `oneWay` says why. `reticle_network { ok }` then matches
      // such a record in neither direction, which is the honest answer to "did it work".
      const verdictless = true === record.oneWay && record.ok === undefined;
      // Declared, not inferred: the server cannot tell "no verdict" from "not yet settled" without
      // being told, and a send with nothing to observe must not read as a clean green.
      if (verdictless)
        emit(EventType.BLIND_SPOT, { kind: BlindSpotKind.VERDICTLESS_SEND, count: 1 });
      const ok = true === record.ok;
      emit(EventType.NET_REQUEST, {
        id: record.id,
        method: NetInitiator.IPC,
        url,
        ...(verdictless ? {} : { ok, status: ok ? IpcStatus.OK : IpcStatus.ERROR }),
        ...(true === record.oneWay ? { oneWay: true } : {}),
        durationMs: record.durationMs ?? 0,
        initiator: NetInitiator.IPC,
        ...(record.error === undefined ? {} : { error: record.error }),
        // Size travels ALWAYS, bodies only on opt-in. The split matters: the verdict layer reports "a
        // write returned ok and its payload went unread" from the size alone, and it cannot infer that
        // from an absent field — an unread payload and an empty one would look identical.
        ...(record.responseSize === undefined ? {} : { responseSize: record.responseSize }),
        ...(true === options.captureBodies
          ? {
              ...(record.requestBody === undefined ? {} : { requestBody: record.requestBody }),
              ...(record.responseBody === undefined ? {} : { responseBody: record.responseBody }),
              ...(true === record.responseBodyTruncated ? { responseBodyTruncated: true } : {}),
            }
          : {}),
      });
    });
  });

  // A REAL removal, so teardown leaves the app as it found it. The preload's `invoke` patch stays
  // deliberately — it is a pass-through with no effect once no subscriber remains, and un-patching
  // mid-flight would strand any call already inside the wrapper.
  return () => {
    channel.unsubscribe?.(token);
  };
}
