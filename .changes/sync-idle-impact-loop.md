### Fixed

- **An idle daemon no longer sends the same impact record every few seconds.** The platform answered `accepted` and then reported a hash of its own form of the record, which never matched the one computed here, so every cycle offered it again; and a cycle that sends something comes round sooner, so an idle machine logged "sent impact" every 5 seconds. The hash of each record the platform accepted is now remembered, and the record goes again only when it changes or the platform no longer holds it.
