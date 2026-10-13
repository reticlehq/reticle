### Fixed

- **`@reticlehq/server` — a stringified `args` in a sequence step is parsed or refused instead of silently dropped.** `sequenceStepArgs` treated a string `args` as not-an-object and fell through to `{}`, so `{ref, action:"fill", args:"{\"value\":\"hi\"}"}` silently sent the fill with no value. Now a valid JSON-object string is parsed and used; anything else throws a descriptive type error naming the step. Closes [#1230](https://github.com/reticlehq/reticle/issues/1230).
