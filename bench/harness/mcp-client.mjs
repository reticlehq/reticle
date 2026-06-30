// Minimal MCP stdio client (JSON-RPC 2.0, newline-delimited framing).
// Used to drive Playwright MCP / Chrome DevTools MCP / Reticle MCP WITHOUT an LLM,
// so we can capture the exact tool-response payloads, wall-clock latency, and
// whether a failure signal is present. This is the "observation-cost" layer and
// needs no API key. The agent-loop layer (agent-loop.mjs) is separate.
import { spawn } from 'node:child_process';

export class McpStdioClient {
  constructor(command, args, env = {}) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.proc = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = [];
  }

  async start() {
    this.proc = spawn(this.command, this.args, {
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => this.stderr.push(d));
    this.proc.on('exit', (code) => {
      for (const [, p] of this.pending) p.reject(new Error(`mcp process exited code=${code}`));
      this.pending.clear();
    });
    // MCP initialize handshake.
    const init = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'reticle-bench', version: '0.0.0' },
    });
    this.notify('notifications/initialized', {});
    return init;
  }

  _onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (line.length === 0) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // non-JSON log line on stdout; ignore
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    }
  }

  request(method, params, timeoutMs = 60000) {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    this.proc.stdin.write(JSON.stringify(payload) + '\n');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs}ms on ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async listTools() {
    const r = await this.request('tools/list', {});
    return r.tools ?? [];
  }

  // Returns { result, latencyMs, text } where text is the concatenated text content.
  async callTool(name, args, timeoutMs = 60000) {
    const t0 = process.hrtime.bigint();
    const result = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const t1 = process.hrtime.bigint();
    const latencyMs = Number(t1 - t0) / 1e6;
    const text = (result?.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    return { result, latencyMs, text };
  }

  async stop() {
    try {
      this.proc?.kill('SIGTERM');
    } catch {
      /* noop */
    }
  }
}
