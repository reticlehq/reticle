### Security

- **`@reticlehq/browser`, `@reticlehq/server` — a password typed into a field with a non-English label was saved in clear into the flow file.** Redaction read only the English words of the field's name, so a field labelled "Mot de passe" kept its value, and that file is checked into git. The SDK now marks an action on a password input, a credential `autocomplete`, or a sensitive field name as `secret`, and the saved flow and `reticle_record stop` redact that fill whatever the label says. An older SDK still gets the name rule.
