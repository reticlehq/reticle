### Security

- **`@reticlehq/browser` — the Impact report escapes a day's date and an estimate's basis.** Both went into a `title` attribute unescaped. The date comes from the project's `.reticle/impact.json`, so a repository that shipped a crafted file could run script in the page when the Impact panel opened. Both now pass through the same escape as the rest of the report.
