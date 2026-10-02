// An adapter over `McpStdioClient`, not a second MCP client.
//
// This file used to be its own implementation: 77 lines that spawned `cli mcp`, buffered stdout on
// newlines, kept a `pending` Map keyed by request id, and resolved on timeout. `mcp-client.mjs` does
// all of that too, for 36 other callers. Two implementations of one wire is two places a protocol
// change has to land, and only one of them has 36 callers keeping it honest.
//
// The API here is UNCHANGED, deliberately: `connect()` returning `{ proc, stderr, init, listTools,
// call, close }` is what `behaviour-matrix.mjs` and `long-horizon.mjs` already call, and rewriting
// two benchmark instruments that cannot be run without a live app and an API key — to save a few
// lines at the call site — is the wrong trade. The duplication was the wire, and the wire is gone.
//
// Three behaviours are preserved because the callers depend on them, and each differs from the
// class's own convenience helpers:
//
//   * RAW JSON-RPC messages. Callers read `(await c.call(...)).result?.content`, so this goes
//     through `request()` rather than `callTool()`, which unwraps and adds a `reticle_run` retry.
//   * NEVER REJECTS. The original resolved `{ __timeout: true }` and had no error path at all; a
//     crashed proxy simply hung until the timeout. Rejecting instead would be a behaviour change in
//     a script nobody can run here, so failures still resolve — with the reason attached, which is
//     strictly more than the original said.
//   * `cwd`. The only thing the class genuinely lacked; it is now an option there.
import { McpStdioClient } from './mcp-client.mjs';

export function connect({ cli, port, cwd, env = {} }) {
  const client = new McpStdioClient(process.execPath, [cli, 'mcp', '--port', String(port)], env, {
    cwd,
  });

  /**
   * Resolve, always, and RE-WRAP the envelope.
   *
   * `McpStdioClient.request()` resolves with `msg.result` (mcp-client.mjs:77), while this client's
   * callers read `(await c.call(...)).result?.content` — the whole JSON-RPC message. Returning the
   * class's value unchanged made `listTools()` report zero tools and every `call()` look empty,
   * which a smoke test against a real daemon caught and a unit test with a fake would not have.
   */
  const rpc = async (method, params, timeoutMs = 45000) => {
    try {
      return { result: await client.request(method, params, timeoutMs) };
    } catch (error) {
      return { __timeout: true, method, params, error: String(error?.message ?? error) };
    }
  };

  return {
    // Getters, because the process does not exist until `init()`. Both callers construct and
    // immediately await `init()`, so this reads the same as the eager version ever did.
    get proc() {
      return client.proc;
    },
    get stderr() {
      return client.stderr;
    },
    // `start()` spawns AND performs the initialize handshake, which is exactly what this did.
    init: () => client.start(),
    listTools: () => rpc('tools/list', {}),
    call: (name, args, timeoutMs) => rpc('tools/call', { name, arguments: args }, timeoutMs),
    // A proxy that already exited is the normal case, not an error worth surfacing.
    close: () => {
      void client.stop().catch(() => undefined);
    },
  };
}
