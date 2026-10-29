### Fixed

- **`@reticlehq/browser` — an SDK in a same-origin iframe no longer takes over the page's session.** A same-origin sub-frame, such as an `about:srcdoc` preview, shares the tab's `sessionStorage`. The SDK inside it read the page's remembered session id, registered under it, and replaced the page's connection. A lease then drove and graded the iframe instead of the page. A sub-frame now gets a session id of its own. Refs [#2009](https://github.com/reticlehq/reticle/issues/2009).
