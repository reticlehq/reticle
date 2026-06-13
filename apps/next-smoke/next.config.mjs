import irisNext from '@iris/next';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship compiled ESM; transpile them through Next to be safe.
  transpilePackages: ['@iris/browser', '@iris/react', '@iris/protocol'],
};

// withIris adds a dev-only source-mapping pre-loader (keeps SWC). No-op in production.
export default irisNext.withIris(nextConfig);
