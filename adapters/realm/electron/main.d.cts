/**
 * Types for the main-process entry, hand-written because the source is hand-written CJS.
 *
 * Without them every TypeScript Electron app — which is most of them — got `any` from
 * `require('@reticlehq/electron/main')`, so a wrong argument to the one function this package
 * exists for was a runtime surprise rather than a compile error.
 */

/**
 * `object`, and deliberately not a structural shape.
 *
 * The obvious version declares the one member this adapter touches — `on?(event, listener)` — and a
 * real `BrowserWindow` does not satisfy it: Electron types `on` as a long list of overloads keyed on
 * literal event names, none of which is assignable to one general signature. The first draft of this
 * file typed it that way and the electron-vite fixture in `apps/` refused to compile, which is what
 * that fixture is for.
 *
 * Naming Electron's own type instead would make a type-only import a real dependency for a package
 * that declares Electron as a PEER, so an app on a different Electron major would fail to compile
 * against types it never asked for. `object` accepts every window and still rejects the argument
 * mistakes worth catching — a string, a number, a forgotten `.webContents`.
 */
export type ReticleCapturableWindow = object;

/**
 * Make this window screenshottable from the daemon.
 *
 * Registers the capture IPC handler once per process and remembers the window, so a capture still
 * resolves when the requesting webContents has gone away. A null or undefined window is ignored
 * rather than throwing — a renderer that never opened is not an error worth crashing a main process
 * over.
 */
export function installReticleCapture(win: ReticleCapturableWindow | null | undefined): void;
