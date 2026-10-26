### Fixed

- **`@reticlehq/engine` — a correctly guarded app was accused of applying a stale response when clicks came fast.** A filter or symbol picker that drops superseded answers was reported as `stale-response-applied` when the next click landed a few milliseconds after the slow answer: that click's own "loading" write was read as the app acting on the old response. A reaction that is nearer a request being issued now belongs to the action that issued it. A page that really renders the old answer is still reported.
