### Added

- **`@reticlehq/core` / `@reticlehq/server`: `RETICLE_INSTALL_SOURCE=blog`.** Install commands in posts on reticle.sh/blog now declare themselves, so the anonymous install event can tell a blog reader's install from an untagged one. It is one more value on the existing closed list; nothing new is collected, and any other value still reports `unknown`.
