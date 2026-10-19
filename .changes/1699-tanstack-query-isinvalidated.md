### Added

- **`@reticlehq/browser` — TanStack Query adapter now exposes `isInvalidated`.** A mutation that calls `queryClient.invalidateQueries` marks the matching queries invalidated. The `reticle_state` snapshot now carries `isInvalidated: true` for those entries, so an agent can distinguish a cache invalidation from a staleTime-based refetch. Closes [#1699](https://github.com/reticlehq/reticle/issues/1699).
