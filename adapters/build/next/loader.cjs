'use strict';
// Webpack pre-loader: applies the Reticle babel transform (adds data-reticle-source) to the
// project's JSX/TSX, then hands the result to next-swc-loader. SWC still does the real
// compile — we only stamp source locations. Dev-only (wired by withReticle).
const babel = require('@babel/core');

let pluginPromise;

module.exports = function reticleNextLoader(source, inputMap) {
  const callback = this.async();
  const filename = this.resourcePath;

  if (!/\.(t|j)sx$/.test(filename) || filename.includes('node_modules')) {
    callback(null, source, inputMap);
    return;
  }

  pluginPromise = pluginPromise || import('@reticlehq/babel-plugin').then((m) => m.default);

  pluginPromise
    .then((plugin) =>
      babel.transformAsync(source, {
        filename,
        sourceType: 'module',
        plugins: [plugin],
        parserOpts: { plugins: ['jsx', 'typescript'] },
        generatorOpts: { retainLines: true },
        configFile: false,
        babelrc: false,
        sourceMaps: true,
        sourceFileName: filename,
      }),
    )
    .then((result) => {
      if (result && typeof result.code === 'string') {
        callback(null, result.code, result.map || inputMap);
      } else {
        callback(null, source, inputMap);
      }
    })
    .catch((err) => {
      // Never break the build for a source-map nicety — fall back to the original source.
      callback(null, source, inputMap);
      void err;
    });
};
