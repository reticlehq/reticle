### Fixed

- **`@reticlehq/server` — calling an unadvertised tool by its own name (`reticle_record`, `reticle_flow_save`) looked like an empty success in some clients.** The refusal that names `reticle_run` was sent as a protocol error, which a client that reads only the tool result shows as no text and no error — so an agent believed its recording had stopped and its flow had been saved when nothing ran. The refusal is now a failed tool result (`isError: true`) carrying the same message, which every client shows.
