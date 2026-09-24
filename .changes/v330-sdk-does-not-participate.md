---
'@reticlehq/browser': patch
'@reticlehq/vite-plugin': patch
---

Two ways the dev SDK changed the app it is supposed to observe.

Escape belongs to the app. A document-level handler called `preventDefault()` on every Escape while the HUD was expanded - the default - which cancels the browser's own close request for a `<dialog>` opened with `showModal()`. Escape stopped closing an app's modals the moment Reticle was installed, so a developer testing their own modal in dev saw a bug that does not exist in production. The key is never cancelled now, and while the app has a modal open the panel does not act on it at all.

Test files are no longer source-stamped. `apply: 'serve'` keeps the plugin out of `vite build` but not out of a test run, so every `.test.tsx` went through Babel to have `data-reticle-source` inserted into its JSX. Nothing reads those attributes on a test file. Measured in the field on ~1250 jsdom tests: 218s without the plugin, 411s with it, and one test that passed without instrumentation failed with it.
