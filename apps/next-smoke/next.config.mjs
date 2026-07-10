import reticleNext from '@reticlehq/next';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship compiled ESM; transpile them through Next to be safe.
  transpilePackages: ['@reticlehq/browser', '@reticlehq/react', '@reticlehq/core'],
};

// withReticle adds a dev-only source-mapping pre-loader (keeps SWC). No-op in production.
export default reticleNext.withReticle(nextConfig);
