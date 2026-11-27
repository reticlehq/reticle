### Added

- **Reticle tells an agent when to go from the page to the computer, and back.** The computer realm can join a native app, a system dialog or a popup that the page opened, but an agent heard of it only in one line of `SKILL.md`. Now:
  - The MCP instructions name `npx -p @reticlehq/computer reticle-computer --app <name>` for a desktop app or a dialog of the operating system, once an app has connected.
  - When an action continues in a window the page SDK cannot enter (an OAuth popup), the `consequence-elsewhere` finding says how to follow it with the computer realm.
  - When `reticle-computer` joins a Chromium browser, its answer says that `reticle_attach_tab` joins the page in it too, for the network, state and source.
