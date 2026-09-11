/**
 * Ports that belong to a DEV SERVER, not to Reticle's bridge. Next defaults to 3000, Vite to 5173,
 * Astro to 4321, and so on.
 *
 * `.reticle.json`'s `port` is the bridge — the daemon ↔ SDK channel, default 4400 — and it has
 * nothing to do with the port the app is served on. Setting it to the dev-server port makes the
 * daemon try to bind the port the app already holds; what the user sees is either a bind failure or
 * a daemon that never connects, neither of which mentions the actual mistake. The old setup skill
 * asked "what port does your dev server run on?" a few lines before showing this field, which is how
 * the confusion got manufactured in the first place.
 *
 * Lives in the scaffolder because `existing-config.ts` is what diagnoses the mistake in a config
 * somebody already wrote, and this package may not import the daemon. `cli/cli-port.ts` re-exports
 * all three for the runtime readers (the dev-server probe and the no-session diagnosis), so nothing
 * on the server side changed.
 */
export const DEV_SERVER_PORTS: ReadonlySet<number> = new Set([
  3000,
  3001,
  4200,
  4321,
  5000,
  5173,
  5174,
  8000,
  8080,
  8100,
  9000,
  // Added after the scan reported "nothing is listening" at people whose app was plainly running.
  // A narrow list is not just unhelpful, it is CONFIDENTLY wrong — the message states absence as a
  // fact — so the defaults of the frameworks agents actually meet belong in it.
  1420, // Tauri
  3100, // Next, second instance
  4173, // vite preview
  5175, // Vite, third instance
  7860, // Gradio
  8501, // Streamlit
]);

export function isLikelyDevServerPort(port: number): boolean {
  return DEV_SERVER_PORTS.has(port);
}

/** The warning printed when a project pins the bridge to something that looks like its dev server. */
export function devServerPortWarning(port: number): string {
  return `[reticle] .reticle.json sets "port": ${port}, which is a common DEV-SERVER port. That field is the Reticle BRIDGE port (default 4400), not the port your app is served on — they must be different, or the daemon fights your dev server for it. Remove "port" unless you are running several apps at once.`;
}
