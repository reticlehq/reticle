// Dev-only: install Iris's React render meter BEFORE react-dom initializes. React reads the
// __REACT_DEVTOOLS_GLOBAL_HOOK__ at renderer-inject time, so the hook must already exist — which is
// why this is imported as the FIRST side-effect in main.tsx, ahead of the react-dom import. The meter
// counts commits and exposes them via the `__iris_renders` store (read with iris_state); it is
// host-safe (augments a real DevTools hook if present, everything in try/catch). Tree-shaken from prod.
import { installRenderMeter } from '@syrin/iris-react';

if (import.meta.env.DEV) installRenderMeter();
