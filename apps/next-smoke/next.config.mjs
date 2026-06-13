/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship compiled ESM; transpile them through Next to be safe.
  transpilePackages: ['@iris/browser', '@iris/react', '@iris/protocol'],
};

export default nextConfig;
