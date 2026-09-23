### Fixed

- **`@reticlehq/cli-realm` — a build that wrote an empty file passed.** `cli.fs.written` said the same word about a zero-byte path as about a real one, and `summary` is the only part of a predicate match that compares exactly — so no claim written over it could tell them apart, and "the build produced `out.txt`" was satisfied by an `out.txt` holding nothing. That is the commonest shape of a build that ran, failed late and left its output path behind.

  An empty write now says `cli.fs.written-empty`. The rule it was protecting is intact: file SIZE is `stat`, decided by the same independent source that decides existence, while the BYTES remain actuation-derived and still cannot buy a `yes`. Measured in `bench/cli-false-green`: the adapter went from 6 of 8 planted defects with two false greens to 8 of 8 with none, both controls still clean. The package remains unpublished.
