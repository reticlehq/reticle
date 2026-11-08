### Fixed

- **`@reticlehq/browser` — an element's name included the body of a `<script>` or `<style>` inside it.** A tab label with an inline script was named with the script source. When the script held a random variable name, the name changed on every page load, and two reads of the same page did not match. A name now leaves out `<script>`, `<style>`, `<noscript>` and `<template>` bodies, because a browser never paints them.
