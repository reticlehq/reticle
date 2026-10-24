### Fixed

- **`@reticlehq/server` — the refusal for a consequential control gave a wrong reason.** It said that labels such as "deploy" and "publish" trip the guard. The guard leaves both out on purpose. The refusal now names only words the guard stops on: delete, remove, revoke, pay.
