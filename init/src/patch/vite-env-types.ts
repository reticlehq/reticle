/**
 * The generated dev module must compile even when the host excludes `vite/client` ambient types.
 * Keep the guard itself as `import.meta.env.DEV` so Vite can remove dev-only code from production.
 *
 * These declarations must merge with Vite's existing interfaces: DEV is mutable there, while env
 * is readonly and refers to the named ImportMetaEnv interface. A triple-slash package reference
 * would also require vite to be directly resolvable, which electron-vite-only projects need not have.
 */
export const VITE_ENV_DEV_DECLARATION = `// Supply the dev flag type when the host does not include vite/client.
// These interfaces merge with vite/client when it is already present.
declare global {
  interface ImportMetaEnv {
    DEV: boolean;
  }
  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}
`;
