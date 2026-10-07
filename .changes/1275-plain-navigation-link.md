### Fixed

- **`@reticlehq/browser` — a same-origin `<a href>` with no click handler is a GET navigation, not a destructive action.** A plain link whose URL or text matched the destructive-label pattern (e.g. `<a href="/billing/payments">Orders & invoices</a>`) was blocked as "potentially destructive" and forced `confirmDangerous: true`. The guard now exempts a same-origin anchor with no `onclick` and no `download`; a link with a click handler, a `download`, or an off-origin/`javascript:` href keeps today's behaviour. Closes [#1275](https://github.com/reticlehq/reticle/issues/1275).
