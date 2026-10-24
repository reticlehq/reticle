### Fixed

- `drag` moves by a pixel offset with `args.by: { x, y }`. An argument it does not read, such as `deltaX`, is refused before the pointer moves, instead of dragging nowhere and reporting success. Closes [#1837](https://github.com/reticlehq/reticle/issues/1837).
