### Changed

- **`@reticlehq/server` — a failed `init_completed` event now says which step stopped.** `dev_server` and `app_connection` each covered several stops with different fixes. The new `init.stop` field names the step: `no_dev_command`, `split_loopback`, `port_busy`, `dev_server_exited`, `no_url`, `not_ready`, `page_not_served`, `page_tls_refused`, `sdk_missing`, `no_session` or `desktop_no_session`. It is a closed set of our own words, never a path, a URL or a log line.
