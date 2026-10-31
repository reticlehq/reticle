### Fixed

- **`@reticlehq/engine` — A text check gets a verdict again on a page whose SDK is older than 3.7.0 or reports no version.** Such a page refuses an element query that carries `matchCase`, so the check graded `unknown` while the page showed the text. The engine now asks the page once more without `matchCase`, and checks the case on the text that the page returns. A check stays case-exact. When the returned text cannot show the case, the verdict stays `unknown`.
