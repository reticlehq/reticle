### Fixed

- **`@reticlehq/server` — a password entered with `type` was saved in plain text in the flow file.** Redaction read only the `value` that a `fill` writes. A `type` step carries its text in `text`, so a password typed key by key reached the saved flow verbatim, even when the SDK marked the field as a secret. Flow files are often in git. The typed text of a `type` step is now redacted like a fill, in the saved flow and in the recorded steps a tool returns, and replay puts the secret back into `text`.
