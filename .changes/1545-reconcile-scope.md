### Added

- `reticle_reconcile` takes an optional `scope` (a ref or CSS selector). It compares only against that subtree and finishes every cut branch inside it. A page that is too large to read completely, for example a dashboard of 500-option selects, can now be reconciled in the region the API feeds. A scope that matches no element is refused. (#1545)
