### Added

- **`@reticlehq/server` — `reticle compare --report <file>` writes the result as one HTML page.** The page shows the verdict, the counts, and each difference with the steps that reproduce it and the lines on each side. It needs no network and runs no script, so you can open it, share it, or keep it as a CI artifact. Text from the pages under test is escaped. If the file cannot be written, the command says so.
