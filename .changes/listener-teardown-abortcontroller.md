### Changed

- **`@reticlehq/browser`: every observer tears its event listeners down through one AbortController.** The frames, download, route, console, workspace-selector, recorder and annotator observers each kept a hand-written list of `removeEventListener` calls, and a listener added later without its twin would have outlived teardown silently. Behaviour is unchanged. Contributed by @Bhumika-1432006 in #947 to #953.
