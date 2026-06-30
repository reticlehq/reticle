'use strict';
// Webpack pre-loader for `@reticle/core/next` — ships INTO the umbrella's dist/ alongside next.js and
// babel.js. Applies the Reticle source-mapping babel transform (stamps data-reticle-source) to the project's
// JSX/TSX, then hands the result to next-swc-loader. SWC still does the real compile; we only stamp
// source locations. Dev-only (wired by withReticle).
//
// Authored as plain CJS (module.exports = function) so webpack requires it directly. The babel plugin
// is NOT imported from the private @reticle/babel-plugin — it's pulled from the umbrella's own
// bundled ./babel (ESM) via dynamic import, so this loader is self-contained inside the published dist.
const babel = require('@babel/core');

let pluginPromise;

module.exports = function reticleNextLoader(source, inputMap) {
  const callback = this.async();
  const filename = this.resourcePath;

  if (!/\.(t|j)sx$/.test(filename) || filename.includes('node_modules')) {
    callback(null, source, inputMap);
    return;
  }

  // The bundled source-mapping plugin is the umbrella's ./babel default export.
  pluginPromise = pluginPromise || import('./babel.js').then((m) => m.default || m);

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
