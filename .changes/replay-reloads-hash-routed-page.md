### Fixed

- **`@reticlehq/server` — replay on a hash-routed app never started.** Before step 1, replay loads the flow's start page by assigning its URL. When the tab was already on that URL (`/#/orders`), or on a URL that differed only in the fragment, the browser jumped within the page and loaded nothing. No new page connected, and every flow after the first stopped after 5 s with "no page was connected". Replay now asks the page to reload after such a navigation, so the start page loads and connects. The fix is in the daemon, so it works with every SDK version.
