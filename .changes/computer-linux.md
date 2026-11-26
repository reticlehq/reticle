### Added

- **`@reticlehq/computer` — Linux.** A helper reads an application through AT-SPI, the accessibility bus of the Linux desktop, and acts on it with the real pointer and keys through `xdotool` on X11. It answers in the same shape as the macOS and Windows helpers, so the same realm drives all three. It reports the pixels that an action changed, and it leaves out what moves by itself. A CI job checks it against a GTK application on an X screen in memory. It does not arrange windows yet, and it does not run on Wayland.
