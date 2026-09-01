import { describe, expect, it } from 'vitest';
import { AppRuntime, BlindSpotKind } from '@reticlehq/core';
import { buildCoverageStatement, forRuntime } from './blind-spots.js';

/**
 * A web page must never be told its Electron IPC is unobserved (#701).
 *
 * A plain Vite + React session on `localhost:5173` was reported as an Electron renderer with
 * unobserved `ipcRenderer.invoke` coverage, while `reticle_sessions` correctly showed
 * `adapters: ["react"]` on the same session. The sentence asserts the runtime as fact — "this
 * Electron renderer has no Reticle preload" — so to a reader with no IPC it says their IPC
 * instrumentation is broken.
 *
 * The cost is not the one wrong row. The reporter's stated workaround was to stop reading the
 * coverage block entirely and rely on network, DOM and console evidence — which throws away every
 * other caveat in it, including the no-registered-store one that WAS applicable to them.
 */
describe('desktop coverage is gated on the session runtime', () => {
  const ipc = { kind: BlindSpotKind.UNOBSERVED_IPC, count: 1 };
  const send = { kind: BlindSpotKind.VERDICTLESS_SEND, count: 2 };
  const state = { kind: BlindSpotKind.UNWATCHED_STATE, count: 1 };

  it('drops an Electron IPC claim on a web session', () => {
    expect(forRuntime([ipc], AppRuntime.WEB)).toEqual([]);
  });

  it('keeps it on an Electron session, which is what it is for', () => {
    expect(forRuntime([ipc], AppRuntime.ELECTRON)).toEqual([ipc]);
  });

  it('keeps every non-desktop spot on a web session', () => {
    // The over-correction guard. The reporter's applicable caveat was this one, and losing it
    // while fixing the noise would trade a wrong row for a missing one.
    expect(forRuntime([ipc, state], AppRuntime.WEB)).toEqual([state]);
  });

  it('drops the one-way IPC send note too, for the same reason', () => {
    // `ipcRenderer.send` cannot happen on a web page either, and it describes itself as IPC.
    expect(forRuntime([send], AppRuntime.WEB)).toEqual([]);
  });

  it('leaves an unreported runtime alone rather than guessing', () => {
    // An older SDK reports no runtime. Withholding a caveat we cannot rule out is the wrong
    // direction for an honesty surface: a missing warning reads as coverage that was never had.
    expect(forRuntime([ipc], undefined)).toEqual([ipc]);
  });

  it('leaves Tauri alone, which is a desktop runtime we do not model here', () => {
    expect(forRuntime([ipc], AppRuntime.TAURI)).toEqual([ipc]);
  });

  it('a web session with only desktop spots reports FULL coverage, not a partial one', () => {
    // The end state that matters: after the gate there is nothing to caveat, so the block is
    // omitted rather than rendered empty.
    const statement = buildCoverageStatement([...forRuntime([ipc, send], AppRuntime.WEB)]);
    expect(statement.note).toBeUndefined();
  });
});
