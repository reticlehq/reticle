'use strict';
// withIris(nextConfig): adds a dev-only webpack pre-loader that stamps data-iris-source on
// your JSX so @syrin/iris-react can report the source file:line — without disabling SWC.

/**
 * @param {import('next').NextConfig} [nextConfig]
 * @returns {import('next').NextConfig}
 */
function withIris(nextConfig = {}) {
  // Production builds are untouched — this is a dev-time aid only.
  if (process.env.NODE_ENV === 'production') return nextConfig;

  const userWebpack = nextConfig.webpack;
  return {
    ...nextConfig,
    webpack(config, ctx) {
      config.module = config.module || { rules: [] };
      config.module.rules = config.module.rules || [];
      config.module.rules.push({
        test: /\.(t|j)sx$/,
        exclude: /node_modules/,
        enforce: 'pre',
        use: [{ loader: require.resolve('./loader.cjs') }],
      });
      return typeof userWebpack === 'function' ? userWebpack(config, ctx) : config;
    },
  };
}

module.exports = { withIris };
