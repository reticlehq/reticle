### Fixed

- **`reticle init` no longer relays npm's "a newer npm is available" block.** Five of the lines in a measured first run on a pristine Vite app were npm announcing a newer npm, its changelog URL and the command to install it: advice about npm, printed in the middle of somebody wiring up a different tool. It joins the audit and funding summaries already suppressed on the install Reticle runs. The command shown in the plan, which a reader may copy and type, is unchanged.
