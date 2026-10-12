### Fixed

- **`@reticlehq/server` — the Harness setup score could never count test ids, and dropped source mapping over one unmapped control.** Nothing ever announced test ids, so "stable test ids" stayed missing on an app that had them on every control; they now count once an acted element carries one, until a verdict records a control that had none. A page that carries source mapping is no longer overruled by one control without a stamp — only by the build turning the stamp off — and every act, not only a verdict, now shows coverage the file:line it reached.
