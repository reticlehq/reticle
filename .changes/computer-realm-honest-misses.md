### Fixed

- **`@reticlehq/engine` — a check that missed in a desktop application says why.** To explain a miss, the engine asks for the element by label and by placeholder. The computer realm has no placeholders and refused that query, and the refusal took the verdict with it: `act_and_wait` said only "did not hold". A diagnostic query a realm cannot answer is now skipped.
- **`@reticlehq/computer` — a key with no element goes to the application.** A press of Escape or a shortcut needs no `ref`, as the server says; the realm failed with "ref '' no longer resolves". The key goes to what has the keyboard.
- **`@reticlehq/computer` — a key to a window or a web page is not refused as covered.** The reach test is for a click at a point; a key goes to what has the keyboard.
- **`@reticlehq/computer` — the reach test follows a deep web page.** It walked eight levels up from the point and refused text deep in Slack's page; it now walks up to the application.
- **`@reticlehq/computer` — a window brought from another Space gets three seconds to settle** before a click on it is refused.
