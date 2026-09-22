### Fixed

- **Docs — an empty `reticle_*` catalog now points at the HTTP transport.** Clients that read their MCP tool list once, Cursor Cloud Agent among them, can have a live daemon and still no tools for the session. The transport page already described `GET /mcp/sse`. The troubleshooting page and the install skill, which are what an agent reads when the tools are missing, did not. They now do. See [#997](https://github.com/reticlehq/reticle/issues/997).
