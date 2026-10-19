### Changed

- **`@reticlehq/browser` — every act ends with a canvas digest, so the frame an action drew is tied to it.** The 500 ms timer could report a click's frame after the next action had started. Now each act and act sequence samples every canvas (the same limit of four) before it answers, so the event falls in the act's window and is attributed to it. It is sent even when nothing changed, because a click that drew nothing is the finding. `canvas.digest` carries `trigger: "act"` or `trigger: "poll"`.
