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
      // @ts-expect-error: electron-vite and standard vite Plugin types mismatch in monorepo
      reticle({
        desktop: true,
        captureNetworkBodies: true,
        ...(Number.isFinite(envPort) && envPort > 0 ? { port: envPort } : {})
      }),
      vue()
    ]
  }
})
