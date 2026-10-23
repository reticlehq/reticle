### Changed

- **`@reticlehq/server` — `reticle_lease` refused the project folder as `root` and did not say what to pass.** Agents pass the folder they work in, and the lease was refused unless the path ended in `.reticle`. A `root` that holds a `.reticle` folder now resolves to `<root>/.reticle`; any other value is refused with the exact path to pass. Closes [#1690](https://github.com/reticlehq/reticle/issues/1690).
