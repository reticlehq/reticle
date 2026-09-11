/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RETICLE_ALLOW_NON_LOCALHOST?: string;
  readonly VITE_RETICLE_TOKEN?: string;
  readonly VITE_RETICLE_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __RETICLE_PORT__: number;
/** Pairing token read from ~/.reticle/pairing-token at config load — the bridge requires it on hello. */
declare const __RETICLE_TOKEN__: string;
