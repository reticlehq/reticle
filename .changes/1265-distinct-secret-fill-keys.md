### Fixed

- **`@reticlehq/server` — a flow can supply different secrets to repeated fills of the same field.** New compiled recordings name separate variables in each fill's `secret` argument, such as `RETICLE_SECRET_PASSWORD` and `RETICLE_SECRET_PASSWORD_2`, and replay resolves each from the call's `secrets` or the daemon environment. Sequence children share the ordering. Existing saved flows retain their unsuffixed supply when loaded or written back. Saving an already anchored flow preserves its supplied names. Closes [#1265](https://github.com/reticlehq/reticle/issues/1265).
