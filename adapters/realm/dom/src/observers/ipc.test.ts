import { afterEach, describe, expect, it } from 'vitest';
import { BlindSpotKind, EventType, IPC_URL_SCHEME, IpcStatus, NetInitiator } from '@reticlehq/core';
import { installIpc, ipcNetOverrides } from './ipc.js';

/** Pretend to be (or not be) an Electron renderer for one test. Restored by the caller. */
function setUserAgent(value: string): () => void {
  const original = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
  Object.defineProperty(navigator, 'userAgent', { value, configurable: true });
  return () => {
    if (original === undefined) Reflect.deleteProperty(navigator, 'userAgent');
    else Object.defineProperty(navigator, 'userAgent', original);
  };
}

interface Emitted {
  type: EventType;
  data: Record<string, unknown>;
}

function recorder(): { emit: (t: EventType, d: Record<string, unknown>) => void; all: Emitted[] } {
  const all: Emitted[] = [];
  return { emit: (type, data) => all.push({ type, data }), all };
}

const teardowns: (() => void)[] = [];

afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
  Reflect.deleteProperty(window, '__reticleIpc');
});

/**
 * The renderer CANNOT patch a contextBridge API: `exposeInMainWorld` installs a deeply frozen,
 * non-configurable object. So Electron IPC is observed in the preload and pushed through this
 * channel — this stands in for `@reticlehq/electron/preload`.
 */
function fakePreload(): (record: Record<string, unknown>) => void {
  // Mirrors the real preload: many subscribers, keyed by token, with a real removal.
  const sinks = new Map<number, (record: Record<string, unknown>) => void>();
  let token = 0;
  Reflect.set(window, '__reticleIpc', {
    subscribe: (callback: (record: Record<string, unknown>) => void) => {
      token += 1;
      sinks.set(token, callback);
      return token;
    },
    unsubscribe: (id: number) => sinks.delete(id),
  });
  return (record) => {
    for (const sink of sinks.values()) sink(record);
  };
}

describe('IPC observer — Electron (reports arrive from the preload shim)', () => {
  it('turns a start/end pair from the preload into the same events a fetch produces', () => {
    const push = fakePreload();
    const { emit, all } = recorder();
    teardowns.push(installIpc(emit));

    push({ phase: 'start', id: 'i1', channel: 'todos:load' });
    push({ phase: 'end', id: 'i1', channel: 'todos:load', ok: true, durationMs: 120 });

    expect(all.map((e) => e.type)).toEqual([EventType.NET_PENDING, EventType.NET_REQUEST]);
    expect(all[0]?.data['url']).toBe(`${IPC_URL_SCHEME}todos:load`);
    expect(all[1]).toMatchObject({
      data: {
        id: 'i1',
        ok: true,
        status: IpcStatus.OK,
        durationMs: 120,
        initiator: NetInitiator.IPC,
      },
    });
  });

  it('carries a failed main-process handler through as ok:false with its message', () => {
    const push = fakePreload();
    const { emit, all } = recorder();
    teardowns.push(installIpc(emit));

    push({ phase: 'start', id: 'i2', channel: 'todos:archive' });
    push({
      phase: 'end',
      id: 'i2',
      channel: 'todos:archive',
      ok: false,
      durationMs: 80,
      error: 'archive is not implemented in the backend',
    });

    expect(all[1]?.data['ok']).toBe(false);
    expect(all[1]?.data['error']).toBe('archive is not implemented in the backend');
    // The synthetic status is what makes the failure findable via reticle_network { status: 500 }.
    expect(all[1]?.data['status']).toBe(IpcStatus.ERROR);
  });

  /**
   * `ipcRenderer.send` is fire-and-forget: the renderer never learns whether the main process
   * handled it. Before this, one-way sends were not observed AT ALL — an app built on
   * `send` + `on('reply')` had every backend call invisible while coverage still read full. They are
   * observed now, but as DISPATCHED: inventing a 200 would be the false green in the other direction.
   */
  it('records a one-way send with no verdict — no ok, no status', () => {
    const push = fakePreload();
    const { emit, all } = recorder();
    teardowns.push(installIpc(emit));

    push({ phase: 'end', id: 'i9', channel: 'window:minimize', oneWay: true, durationMs: 0 });

    // The call itself, plus a blind spot declaring that its outcome is unobservable. Both are
    // required: without the record the call is invisible, and without the blind spot a verdict over
    // it reads as a clean green, since no channel can disagree with a channel that reports nothing.
    const call = all.find((e) => e.type === EventType.NET_REQUEST);
    expect(call?.data['url']).toBe(`${IPC_URL_SCHEME}window:minimize`);
    expect(call?.data['oneWay']).toBe(true);
    expect(call?.data).not.toHaveProperty('ok');
    expect(call?.data).not.toHaveProperty('status');

    const spot = all.find((e) => e.type === EventType.BLIND_SPOT);
    expect(spot?.data['kind']).toBe(BlindSpotKind.VERDICTLESS_SEND);
  });

  it('still reports a one-way send that THREW at the call site as a real failure', () => {
    const push = fakePreload();
    const { emit, all } = recorder();
    teardowns.push(installIpc(emit));

    push({
      phase: 'end',
      id: 'i10',
      channel: 'window:minimize',
      oneWay: true,
      ok: false,
      error: 'port closed',
    });

    expect(all[0]?.data['ok']).toBe(false);
    expect(all[0]?.data['status']).toBe(IpcStatus.ERROR);
    expect(all[0]?.data['error']).toBe('port closed');
  });

  it('never lets a throwing emit escape into the app', () => {
    const push = fakePreload();
    teardowns.push(
      installIpc(() => {
        throw new Error('sink exploded');
      }),
    );
    expect(() => push({ phase: 'start', id: 'i3', channel: 'todos:load' })).not.toThrow();
  });

  it('stops emitting after teardown', () => {
    const push = fakePreload();
    const { emit, all } = recorder();
    installIpc(emit)();

    push({ phase: 'start', id: 'i4', channel: 'todos:load' });
    expect(all).toEqual([]);
  });

  /**
   * A single-slot sink meant a second connect() in the same renderer silently stole the first one's
   * subscription, and "teardown" was really "overwrite with a no-op" — so tearing one session down
   * killed reporting for the other. Both must be able to observe, and each must remove only itself.
   */
  it('supports two independent subscribers, and removing one leaves the other reporting', () => {
    const push = fakePreload();
    const first = recorder();
    const second = recorder();
    const stopFirst = installIpc(first.emit);
    teardowns.push(installIpc(second.emit));

    push({ phase: 'start', id: 'i1', channel: 'todos:load' });
    expect(first.all).toHaveLength(1);
    expect(second.all).toHaveLength(1);

    stopFirst();
    push({ phase: 'start', id: 'i2', channel: 'todos:load' });
    expect(first.all, 'the torn-down subscriber must stop').toHaveLength(1);
    expect(second.all, 'the surviving subscriber must keep reporting').toHaveLength(2);
  });

  it('tolerates an older preload with no unsubscribe rather than throwing', () => {
    const sinks: ((record: Record<string, unknown>) => void)[] = [];
    Reflect.set(window, '__reticleIpc', {
      subscribe: (cb: (record: Record<string, unknown>) => void) => sinks.push(cb),
    });
    const { emit } = recorder();
    expect(() => installIpc(emit)()).not.toThrow();
  });

  it('is inert with no preload shim (Tauri, and any plain web page)', () => {
    const { emit, all } = recorder();
    expect(() => teardowns.push(installIpc(emit))).not.toThrow();
    expect(all).toEqual([]);
  });
});

describe('an Electron renderer with no preload declares the blind spot instead of reading clean', () => {
  it('emits UNOBSERVED_IPC when the shim is missing but this IS Electron', () => {
    // Without this, a forgotten preload line makes reticle_network report nothing forever — which
    // reads as "this app makes no backend calls" and makes every `assert { net }` vacuously true.
    const restore = setUserAgent('Mozilla/5.0 Electron/34.0.0 Chrome/130');
    const { emit, all } = recorder();
    try {
      teardowns.push(installIpc(emit));
      expect(all).toEqual([
        { type: EventType.BLIND_SPOT, data: { kind: BlindSpotKind.UNOBSERVED_IPC, count: 1 } },
      ]);
    } finally {
      restore();
    }
  });

  it('says nothing on a plain web page — no IPC there to be blind to', () => {
    const restore = setUserAgent('Mozilla/5.0 Chrome/130');
    const { emit, all } = recorder();
    try {
      teardowns.push(installIpc(emit));
      expect(all).toEqual([]);
    } finally {
      restore();
    }
  });

  it('says nothing when the shim IS installed', () => {
    const restore = setUserAgent('Mozilla/5.0 Electron/34.0.0 Chrome/130');
    const { emit, all } = recorder();
    try {
      fakePreload();
      teardowns.push(installIpc(emit));
      expect(all).toEqual([]);
    } finally {
      restore();
    }
  });
});

describe('ipcNetOverrides — a Tauri invoke arrives as a fetch to its ipc:// protocol', () => {
  it('leaves an ordinary HTTP request alone', () => {
    expect(ipcNetOverrides('https://api.example/users', () => null)).toBeUndefined();
    expect(ipcNetOverrides('/api/users', () => 'error')).toBeUndefined();
  });

  it('normalizes the command URL and reports Ok', () => {
    expect(ipcNetOverrides('ipc://localhost/load_todos', () => 'ok')).toEqual({
      url: `${IPC_URL_SCHEME}load_todos`,
      initiator: NetInitiator.IPC,
      method: NetInitiator.IPC,
      ok: true,
      status: IpcStatus.OK,
      // Overwrites the transport's own statusText so the record cannot contradict itself.
      statusText: 'Ok',
    });
  });

  /**
   * The whole reason this exists: Tauri answers HTTP 200 for a command that returned Err, so without
   * translating the header a failed Rust command is recorded as a successful request — a false green.
   */
  it('turns a Tauri-Response: error into a failed call despite the HTTP 200', () => {
    expect(ipcNetOverrides('ipc://localhost/archive_todo', () => 'error')).toMatchObject({
      url: `${IPC_URL_SCHEME}archive_todo`,
      ok: false,
      status: IpcStatus.ERROR,
    });
  });

  it('treats a missing header as success (a non-Tauri producer on the same scheme)', () => {
    expect(ipcNetOverrides('ipc://localhost/whatever', () => null)).toMatchObject({ ok: true });
  });

  /**
   * Tauri v2 on Windows (and Android) needs a real http origin, so `invoke` travels to
   * `http://ipc.localhost/<command>` rather than the `ipc://` custom scheme. Matching only the
   * custom scheme left every Windows command recorded as an ordinary HTTP 200 — so the
   * `Tauri-Response` translation never ran and a failed Rust command read as a success. This is
   * the same hostname `reticle doctor` already tells people to allow in their CSP.
   */
  it('recognises the Windows/Android http form, so a failed command is not banked as a 200', () => {
    expect(ipcNetOverrides('http://ipc.localhost/load_todos', () => 'ok')).toMatchObject({
      url: `${IPC_URL_SCHEME}load_todos`,
      initiator: NetInitiator.IPC,
      ok: true,
    });
    expect(ipcNetOverrides('http://ipc.localhost/archive_todo', () => 'error')).toMatchObject({
      url: `${IPC_URL_SCHEME}archive_todo`,
      ok: false,
      status: IpcStatus.ERROR,
      statusText: 'Err',
    });
  });

  it('does not treat a lookalike host as Tauri IPC', () => {
    // `ipc.localhost.evil.com` is a REMOTE host that merely starts with the reserved label. Treating
    // it as IPC would let a remote page's request masquerade as a local command in the evidence.
    expect(ipcNetOverrides('http://ipc.localhost.evil.com/archive_todo', () => 'error')).toBe(
      undefined,
    );
    expect(ipcNetOverrides('http://notipc.localhost/archive_todo', () => 'error')).toBe(undefined);
  });
});

describe('an IPC record must not contradict itself', () => {
  /**
   * A Tauri IPC failure used to be emitted as `status: 500` while the transport's own
   * `statusText: "OK"` passed straight through, because the underlying fetch really did answer 200.
   * The resulting record read as nonsense to anyone looking at it cold, and "OK" next to 500 is
   * exactly the kind of internal contradiction this project exists to eliminate — in its own output.
   *
   * The synthetic status stays (it is what makes `reticle_network { status: 500 }` work uniformly),
   * but the record must describe ONE consistent story.
   */
  it('clears a transport statusText that would disagree with the command verdict', () => {
    const failed = ipcNetOverrides('ipc://localhost/archive_todo', () => 'error');
    expect(failed?.['status']).toBe(IpcStatus.ERROR);
    expect(failed?.['statusText']).toBe('Err');
  });

  it('describes a successful command consistently too', () => {
    const ok = ipcNetOverrides('ipc://localhost/load_todos', () => 'ok');
    expect(ok?.['status']).toBe(IpcStatus.OK);
    expect(ok?.['statusText']).toBe('Ok');
  });
});

describe('IPC payloads — a desktop app has no other API surface', () => {
  /**
   * Every payload-based check — a batch whose ok envelope hides per-item failures, a money value
   * written back at the wrong scale — was web-only on Electron, because this observer reported only
   * channel, ok and duration and dropped the payloads the preload was already holding.
   */
  const batch = {
    phase: 'end',
    id: 'i1',
    channel: 'todos:bulkDone',
    ok: true,
    durationMs: 9,
    requestBody: '[[1,2,3]]',
    responseBody: '{"results":[{"id":1,"ok":true},{"id":3,"ok":false}]}',
    responseSize: 52,
  };

  it('forwards the payloads when capture is on', () => {
    const push = fakePreload();
    const { emit, all } = recorder();
    teardowns.push(installIpc(emit, { captureBodies: true }));
    push(batch);
    const settled = all.find((e) => e.type === EventType.NET_REQUEST);
    expect(settled?.data['requestBody']).toBe(batch.requestBody);
    expect(settled?.data['responseBody']).toBe(batch.responseBody);
  });

  it('withholds the payloads when capture is off, but ALWAYS reports the size', () => {
    const push = fakePreload();
    const { emit, all } = recorder();
    teardowns.push(installIpc(emit));
    push(batch);
    const settled = all.find((e) => e.type === EventType.NET_REQUEST);
    expect(settled?.data['responseBody']).toBeUndefined();
    expect(settled?.data['requestBody']).toBeUndefined();
    // The size is what lets a verdict say "this write's payload went unread" — without it, an unread
    // payload and an empty one are indistinguishable, which is the whole failure being prevented.
    expect(settled?.data['responseSize']).toBe(52);
  });

  it('marks a payload the preload had to cut', () => {
    const push = fakePreload();
    const { emit, all } = recorder();
    teardowns.push(installIpc(emit, { captureBodies: true }));
    push({ ...batch, responseBodyTruncated: true });
    const settled = all.find((e) => e.type === EventType.NET_REQUEST);
    expect(settled?.data['responseBodyTruncated']).toBe(true);
  });

  it('carries nothing extra for a call the preload could not serialize', () => {
    const push = fakePreload();
    const { emit, all } = recorder();
    teardowns.push(installIpc(emit, { captureBodies: true }));
    push({ phase: 'end', id: 'i2', channel: 'todos:load', ok: true, durationMs: 3 });
    const settled = all.find((e) => e.type === EventType.NET_REQUEST);
    expect(settled?.data['responseBody']).toBeUndefined();
    expect(settled?.data['responseSize']).toBeUndefined();
  });
});
