/**
 * What a user reads when the bridge port is already taken by a daemon.
 *
 * `verify` boots its OWN daemon, and it has to do so on the port the APP dials, a loopback page
 * connects natively to the port baked into its config, so verify cannot simply pick a free one and
 * still be found. On any machine with Reticle set up, that port already belongs to a running daemon.
 *
 * It used to die there. The listen failure surfaces asynchronously on the server object, after
 * `start` has resolved, so nothing caught it and the process printed a raw `node:net` stack, the
 * worst answer available, and reached most often by the people with the fewest other options, since
 * the skill offers this command as the way to a verdict with no MCP at all.
 *
 * The message says every way out rather than picking one, and it says FIRST that a busy port is the
 * normal state rather than a fault: an install that worked leaves a daemon on it, so a reader who
 * arrives here has done nothing wrong and should not go looking for what they broke (#689).
 *
 * `reticle drive` leads, because it is the only option that works in the state most people are in
 * when they reach this message: the client exposes no `reticle_*` tools (Codex, Cursor Cloud,
 * Antigravity, a session whose MCP link dropped), which is exactly when the CLI is reached for. It
 * ATTACHES to the running daemon rather than binding (see cli/drive/drive-attach.ts), so there is
 * nothing to stop, nothing to race, and it hands back a sessionId the daemon owns. The advice that
 * used to lead, "ask the daemon through the tools", is the one thing that reader by construction
 * cannot do.
 *
 * Stopping the daemon stays on the list and stays LAST of the working options, with the reason: the
 * MCP proxy respawns one into the gap, so `stop` is a race the caller usually loses, and it kills
 * the agent's own link on the way past.
 *
 * `verify` itself attaching, rather than needing the port at all, is the real fix and is #689's
 * first bullet, not this change.
 *
 * `ignoreHTTPSErrors` says the refusal came from `--ignore-https-errors` (#1713). Then the one
 * command in the list that CAN honour the flag has to carry it, or the way out loses it exactly
 * like the run that refused did.
 */
export function portBusyMessage(port: number, ignoreHTTPSErrors = false): string {
  const certFlag = ignoreHTTPSErrors ? ' --ignore-https-errors' : '';
  const certNote = ignoreHTTPSErrors
    ? '\n\n  --ignore-https-errors only reaches a browser `verify` opens itself. The daemon on that port ' +
      'owns the browser, so the flags IT was started with decide whether a self-signed certificate ' +
      'is accepted, and this run refused rather than drop the flag.\n'
    : '';
  return (
    `reticle verify needs port ${String(port)}, the port your app dials, and a Reticle daemon is ` +
    'already listening on it. It did not start a second one.\n\n' +
    '  This is the NORMAL state after a working install, not a fault: the daemon your MCP client ' +
    'started owns that port.\n' +
    certNote +
    '\n' +
    `  • Drive the app through the daemon that is already there: this needs no tools and stops ` +
    `nothing: npx @reticlehq/server drive <url>${certFlag}\n` +
    '  • If your client HAS the Reticle tools, ask that daemon directly: ' +
    'reticle_run { tool: "reticle_verify", args: { action: "change", files: ["..."] } }\n' +
    `  • Or run both on another port, if your app is configured for it: RETICLE_PORT=<port> ` +
    'npx @reticlehq/server verify <url>\n' +
    `  • Stopping the daemon (npx @reticlehq/server stop --port ${String(port)}) works, but it cuts ` +
    "your agent's MCP link and the proxy usually respawns a daemon into the gap before verify can " +
    'bind. Prefer one of the above.'
  );
}
