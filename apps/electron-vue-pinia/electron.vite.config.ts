import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { reticle } from '@reticlehq/vite-plugin'

const envPort = Number(process.env['RETICLE_PORT'])

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [
      // No suppression: the plugin is assignable to Vite's own `Plugin`, and this fixture is the
      // only place in the repo that typechecks it through a WRAPPING framework's config, which is
      // exactly the position users reported it failing in.
      // `desktop: true` is load-bearing: without it the plugin is serve-only and a packaged
      // renderer ships with no connect(). First in the array so the framework plugin cannot
      // transform the entry before ours has stamped it.
      reticle({
        desktop: true,
        captureNetworkBodies: true,
        ...(Number.isFinite(envPort) && envPort > 0 ? { port: envPort } : {})
      }),
      vue()
    ]
  }
})
