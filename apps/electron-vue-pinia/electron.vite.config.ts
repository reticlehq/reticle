import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { reticle } from '@reticlehq/vite-plugin'

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
      vue(),
      // No suppression: the plugin is assignable to Vite's own `Plugin`, and this fixture is the
      // only place in the repo that typechecks it through a WRAPPING framework's config, which is
      // exactly the position users reported it failing in.
      reticle()
    ]
  }
})
