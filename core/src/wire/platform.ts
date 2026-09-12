/**
 * What kind of surface an app presents, which decides what can be demanded of it.
 *
 * This is deliberately NOT the list of shells. "Which shell is this" -- a browser, Electron, Tauri --
 * is a question about what somebody is using, and it belongs to the usage contract. "What kind of
 * surface is this" is a question about what can be observed, and it is the one verification needs.
 *
 * Electron and Tauri are two different products and one kind of surface: a web page inside a native
 * window. Code that branched on the shell had to name both, and would have to name a third that
 * behaved identically. Code that branches on the surface names `webview` once.
 *
 * There are no dependencies here on purpose. A third-party implementation says which of these it is
 * and needs nothing else from us to say it.
 *
 * Absent on the wire means `web`. That is the back-compat convention used throughout the handshake:
 * a field nobody sent means what everything meant before the field existed.
 */
export const PlatformProfile = {
  /** A browser document. The page owns the window. */
  WEB: 'web',
  /**
   * A web page inside something else's window: Electron's renderer, Tauri, Capacitor, a React
   * Native WebView. It renders like the web and the window around it is not ours.
   */
  WEBVIEW: 'webview',
  /**
   * A native view tree -- iOS, Android, Flutter. There are elements and they are not DOM nodes, so
   * anything that assumes a document is wrong here.
   */
  NATIVE: 'native',
  /**
   * No rendering surface at all: a job, a worker, an API. It can still be observed and it can still
   * be asserted about; it just cannot be looked at or photographed.
   */
  SERVICE: 'service',
} as const;
export type PlatformProfile = (typeof PlatformProfile)[keyof typeof PlatformProfile];
