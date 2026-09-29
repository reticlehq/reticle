### Fixed

- **`@reticlehq/browser` — `getAccessibleName` ignored a native `<label for>` on any element other than `input`/`textarea`/`select`.** A `<button role="combobox">`, `<meter>`, `<output>` or `<progress>` labelled with `<label for="...">` was named from its own content (or left unnamed) instead, so `by: role` + name could not address it and callers had to fall back to refs. `.labels` is now read for any labelable element, before the content/value fallbacks. Closes [#1145](https://github.com/reticlehq/reticle/issues/1145).
