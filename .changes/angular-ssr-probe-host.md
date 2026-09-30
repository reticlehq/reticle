### Fixed

- **`@reticlehq/server` — an Angular SSR dev terminal filled with `ERROR: Bad Request ("http://[::1]:4200/")` every few seconds.** The daemon's background dev-server probe dialled `::1` and sent that literal address as its `Host` header, which Angular's SSR server rejects. The probe still dials both loopback families, and now always names `localhost:<port>`, which is what a browser on the same machine sends.
