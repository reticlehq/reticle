// Native console.warn captured at module load, BEFORE installConsole patches console.
// SDK-internal diagnostics (transport failures, unreachable-bridge, store registration warnings)
// MUST use this instead of bare `console.warn` — otherwise they emit spurious CONSOLE_WARN
// events to the agent, polluting the observation stream with SDK internals.
const g: typeof globalThis = globalThis;

const realWarn = 'function' === typeof g.console?.warn ? g.console.warn.bind(g.console) : null;

export const nativeWarn = (...args: unknown[]): void => {
  realWarn?.(...args);
};
