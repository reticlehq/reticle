/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_IRIS_ALLOW_NON_LOCALHOST?: string;
  readonly VITE_IRIS_TOKEN?: string;
  readonly VITE_IRIS_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __IRIS_PORT__: number;
