### Fixed

- **`reticle_act { action: "type" }` accepts the `fill` spelling `{ value }`.** When `text` is absent and `value` is a string, `value` becomes `text`, in the flat args and in the nested `args` object; a non-string `value` is left alone so the browser's own refusal keeps its accurate message. Closes [#2126](https://github.com/reticlehq/reticle/issues/2126).
