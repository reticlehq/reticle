### Fixed

- **`@reticlehq/core` — a predicate sent as a JSON string was checked as page text, so a check that held answered `no`.** Some clients send `until` as a string that holds the object: `"{\"kind\":\"text\",\"contains\":\"Saved\"}"`. Reticle read it as text that the page must show, and no page shows it. Now a string that starts with `{` and holds a JSON object is read as that object, and the report names the conversion. Any other string that starts with `{` is refused with the form to send. Closes [#1117](https://github.com/reticlehq/reticle/issues/1117).
