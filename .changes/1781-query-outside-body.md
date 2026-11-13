### Fixed

- **`@reticlehq/browser`: page content outside `<body>` was invisible to `find` and `text` checks.** Unscoped queries searched only within `document.body`, so text living in other elements (for example an overlay injected as a sibling of `<body>`) could not be found even though it was on the page. `find` and `text` now search from `<html>`, still excluding `<head>` internals like `<title>` and `<style>`, and zero-match hints and split-phrase recovery describe that same search space. Closes [#1781](https://github.com/reticlehq/reticle/issues/1781).
