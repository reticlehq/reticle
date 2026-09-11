/**
 * Reticle's OWN desktop traffic must not appear in the app's network evidence.
 *
 * On Tauri there is no preload, so `reticle_screenshot` reaches the shell the only way it can: an
 * `invoke` — which Tauri sends as a real `fetch` to its `ipc://` protocol, straight through the
 * patch this very observer installed. So the observer recorded its own screenshots as app IPC calls,
 * and three concurrent captures inside one action window were reported to the agent as
 * `duplicate-request`: "the same write fired 3 times" against an app that never made the call at all.
 * Measured on the packaged Tauri smoke app, `ipc://reticle_capture` ×4.
 *
 * The Electron side has always been safe here — its preload captures through the UNPATCHED invoke
 * for exactly this reason — and the bridge's own WebSocket is skipped on the same principle. This is
 * the third instrument that was measuring itself.
 */
import { describe, expect, it } from 'vitest';
import { EventType, IpcStatus, RETICLE_TAURI_CAPTURE_COMMAND } from '@reticlehq/core';
import { installNetwork } from './network.js';
import { ipcNetOverrides, isReticleOwnIpc } from './ipc.js';
import type { Emit } from './types.js';

/** The Tauri IPC endpoint, exactly as `ipc-protocol.js` builds it on macOS/Linux. */
const tauriIpcUrl = (command: string): string => `ipc://localhost/${command}`;

interface Emitted {
  type: EventType;
  data: Record<string, unknown>;
}

/** The network observer wired the way `installAllObservers` wires it — the composition IS the fix. */
function observedFetch(response: Response): {
  events: Emitted[];
  teardown: () => void;
} {
  const events: Emitted[] = [];
  const emit: Emit = (type, data) => {
    events.push({ type, data });
  };
  Object.defineProperty(window, 'fetch', {
    value: () => Promise.resolve(response),
    configurable: true,
    writable: true,
  });
  const teardown = installNetwork(emit, { reinterpret: ipcNetOverrides, ignore: isReticleOwnIpc });
  return { events, teardown };
}

const okResponse = (): Response =>
  ({ status: 200, ok: true, statusText: 'OK', headers: new Headers() }) as Response;

const netEvents = (events: Emitted[]): Emitted[] =>
  events.filter((e) => e.type === EventType.NET_PENDING || e.type === EventType.NET_REQUEST);

describe("Reticle's own Tauri IPC", () => {
  it('is not observed at all — neither pending nor completed', async () => {
    const { events, teardown } = observedFetch(okResponse());
    try {
      await window.fetch(tauriIpcUrl(RETICLE_TAURI_CAPTURE_COMMAND), { method: 'POST' });
      expect(netEvents(events)).toEqual([]);
    } finally {
      teardown();
    }
  });

  it('still returns the response to the caller it was skipped for', async () => {
    const response = okResponse();
    const { teardown } = observedFetch(response);
    try {
      expect(await window.fetch(tauriIpcUrl(RETICLE_TAURI_CAPTURE_COMMAND))).toBe(response);
    } finally {
      teardown();
    }
  });

  // ── negative controls: the app's own IPC is still fully observed ────────────────────────────
  it("observes the APP's commands exactly as before, verdict and all", async () => {
    const { events, teardown } = observedFetch(okResponse());
    try {
      await window.fetch(tauriIpcUrl('archive_todo'), { method: 'POST' });
      const completed = events.filter((e) => e.type === EventType.NET_REQUEST);
      expect(completed).toHaveLength(1);
      expect(completed[0]?.data['url']).toBe('ipc://archive_todo');
      expect(completed[0]?.data['status']).toBe(IpcStatus.OK);
      expect(events.filter((e) => e.type === EventType.NET_PENDING)).toHaveLength(1);
    } finally {
      teardown();
    }
  });

  it('still records a REAL double submit as two calls', async () => {
    const { events, teardown } = observedFetch(okResponse());
    try {
      await window.fetch(tauriIpcUrl('archive_todo'), { method: 'POST' });
      await window.fetch(tauriIpcUrl('archive_todo'), { method: 'POST' });
      const completed = events.filter((e) => e.type === EventType.NET_REQUEST);
      expect(completed).toHaveLength(2);
      expect(new Set(completed.map((e) => e.data['id'])).size).toBe(2);
    } finally {
      teardown();
    }
  });

  it('does not mistake an app command whose name merely contains ours', async () => {
    const { events, teardown } = observedFetch(okResponse());
    try {
      await window.fetch(tauriIpcUrl(`${RETICLE_TAURI_CAPTURE_COMMAND}_audit`), { method: 'POST' });
      expect(events.filter((e) => e.type === EventType.NET_REQUEST)).toHaveLength(1);
    } finally {
      teardown();
    }
  });

  it('leaves ordinary HTTP alone', () => {
    expect(isReticleOwnIpc('https://api.example.com/reticle_capture')).toBe(false);
    expect(isReticleOwnIpc(tauriIpcUrl(RETICLE_TAURI_CAPTURE_COMMAND))).toBe(true);
    // Windows spells the same endpoint over a real http origin.
    expect(isReticleOwnIpc(`http://ipc.localhost/${RETICLE_TAURI_CAPTURE_COMMAND}`)).toBe(true);
  });
});
