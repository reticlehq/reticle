import irisNext from '@syrin/next';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship compiled ESM; transpile them through Next to be safe.
  transpilePackages: ['@syrin/browser', '@syrin/react', '@syrin/protocol'],
};

// withIris adds a dev-only source-mapping pre-loader (keeps SWC). No-op in production.
export default irisNext.withIris(nextConfig);
