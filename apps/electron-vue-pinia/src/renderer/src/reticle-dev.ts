// Dev-only. Imported automatically by @reticlehq/vite-plugin, so you do not need to import it.
// Self-guards on import.meta.env.DEV, so it is a no-op in a production build.
import { registerCapabilities } from '@reticlehq/browser'

if (import.meta.env.DEV) {
  // Pinia is installed in main.ts AFTER this module is imported (the plugin prepends connect to
  // the HTML entry). Calling useAppStore() here would throw. Uncomment once you register from a
  // setup() that runs after app.use(createPinia()):
  // import { registerStore, piniaStore } from '@reticlehq/browser'
  // import { useAppStore } from './stores/app'
  // registerStore('app', piniaStore(useAppStore()))

  registerCapabilities({
    testids: ['send-ipc', 'docs-link'],
    signals: [],
    stores: []
  })
}
