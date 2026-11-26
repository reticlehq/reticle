### Added

- **`@reticlehq/computer` — the words in a picture, for an application with no elements.** On macOS, `reticle_screenshot` of a desktop session gives `texts`: the words in the picture, each with its box in the pixels of the picture, read on the machine by Apple Vision. A canvas, a game or a remote desktop has no elements, and the box of a word is the point to give to `args.point`. Words the reader is not sure of, and words past 200, are left out and counted in `textsCut`.
