### Fixed

- **`@reticlehq/browser` — `attachShadow` stayed patched after a hot reload tore down the older SDK instance first.** With two live installs, tearing down the older one and then the newer one put the older install's retired patch back on `Element.prototype.attachShadow`, with the shadow-root registry already cleared. The last teardown now restores the original `attachShadow`. Closes [#2454](https://github.com/reticlehq/reticle/issues/2454).
