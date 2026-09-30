export const RETICLE_DISABLED_STUB = '\0reticle-disabled-stub';

const BUILD_COMMAND = 'build';
/** The mode `vite build` and `electron-vite build` use unless the command line says otherwise. */
const PRODUCTION_MODE = 'production';

/**
 * Whether this is a build that must ship no Reticle runtime at all: the SDK swapped for the stub
 * below, nothing injected.
 *
 * Every production build, desktop included. `desktop: true` used to exempt the whole build, and it
 * is what `reticle init` writes for electron-vite, so a RELEASE renderer carried the full SDK and
 * dialled `ws://localhost:<port>/reticle`: `electron-vite preview` of a production build connected
 * to the daemon. A release binary gets the same guarantee a web bundle does. A packaged desktop
 * build that SHOULD be instrumented (a smoke app driven headless) says so the way Vite already
 * provides, by building in another mode: `vite build --mode development`. An unknown mode counts as
 * production, because the cost of guessing wrong the other way is an instrumented release.
 */
export const isReticleDisabledBuild = (
  desktop: boolean,
  command: string | undefined,
  mode: string | undefined,
): boolean =>
  BUILD_COMMAND === command && (!desktop || mode === undefined || PRODUCTION_MODE === mode);

export const RETICLE_DISABLED_STUB_CODE = `
export class Reticle {
  connect() {}
  signal() {}
  state() {}
  renderCommit() {}
  describe() {}
  endSession() {}
  observeHotUpdates() {}
  disconnect() {}

  get connected() {
    return false;
  }
}

export const reticle = new Reticle();

export const SESSION_AUTO = 'auto';

export function setIgnoreSelectors() {}

export function registerAdapter() {}
export function identifyComponent() {
  return null;
}
export function readComponentState() {
  return undefined;
}
export function elementHasHoverHandlers() {
  return false;
}
export function adapterNames() {
  return [];
}

export function registerStore() {}
export function unregisterStore() {}
export function storeNames() {
  return [];
}
export function readStores() {
  return {};
}
export function readStoresWithTruncation() {
  return { stores: {} };
}
export function sourceOwner() {
  return undefined;
}
export function markAdapterSource() {}

export function tanstackQueryStore() {
  return undefined;
}
export function jotaiStore() {
  return undefined;
}
export function xstateStore() {
  return undefined;
}
export function valtioStore() {
  return undefined;
}
export function mobxStore() {
  return undefined;
}
export function recoilStore() {
  return undefined;
}
export function svelteStore() {
  return undefined;
}
export function piniaStore() {
  return undefined;
}
export function pushStore() {
  return undefined;
}

export function registerCapabilities() {}
export function getCapabilities() {
  return {};
}
export function hasCapabilities() {
  return false;
}
export function setCapabilitiesListener() {}

export function createReticleEmitter() {
  return {
    signal() {},
    state() {},
  };
}

export function commitAndSignal() {}
export function registerReticleDomain() {}

export function buildSnapshot() {
  return {};
}

export function inspectChart() {
  return {};
}
export function canvasChartData() {
  return {};
}

export function matchQuery() {
  return false;
}
export function runQuery() {
  return undefined;
}

export function executeAction() {
  return undefined;
}
export function executeSequence() {
  return undefined;
}

export function describe() {
  return undefined;
}
export function getRole() {
  return undefined;
}
export function getAccessibleName() {
  return undefined;
}
export function getStates() {
  return {};
}
export function isVisible() {
  return false;
}

export class RefRegistry {
  get size() {
    return 0;
  }

  markEdited() {}

  mintedBeforeLastEdit() {
    return false;
  }

  refFor() {
    return undefined;
  }

  resolve() {
    return null;
  }
}

export const refs = new RefRegistry();

export class Annotator {
  constructor() {}

  get active() {
    return false;
  }

  get markCount() {
    return 0;
  }

  mount() {}
  unmount() {}
}

export function installAnnotator() {}

export function resolveMarkAnchor() {
  return undefined;
}
`;
