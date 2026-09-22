import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect as connectTcp, type Socket } from 'node:net';

/**
 * A proxy that writes down which hosts a tool dialled, and reads nothing it sent.
 *
 * The one thing a shell cannot do. An agent with `Bash` can diff a filesystem and read an exit
 * code; it has no way whatsoever to learn that a command called out, and `exited 0 and never made
 * the request` is invisible to it.
 *
 * ## Why a CONNECT log and not interception
 *
 * Intercepting TLS would yield `net` at CONSEQUENCE grade -- status codes, response bodies, the
 * answer the far side actually gave. It also costs a certificate authority the subject has to
 * trust, which is a large thing to ask of somebody who wanted to check their build tool, and it
 * puts this code in the path of every byte they send.
 *
 * A CONNECT log costs none of that. It is measured to work on `gh`, `vercel`, `npm`, `git` and
 * `claude` with no flags, and it answers the question nothing else here can: *did it call out at
 * all, and to whom?* That buys PRESENCE grade, which cannot prove a pull request exists and can
 * convict a tool that exited 0 having never contacted the host its claim named.
 *
 * Consequence-grade `net` is a later question, and it should stay later: the cheap half of this
 * is most of the value, and the expensive half asks the user for trust.
 */

/** One host a tool asked to reach. Not what it said to them. */
export interface ConnectAttempt {
  readonly host: string;
  readonly port: number;
  readonly at: number;
}

export interface ConnectProxy {
  readonly port: number;
  /** Everything dialled since a moment on the injected clock. */
  connectsSince(at: number): readonly ConnectAttempt[];
  /**
   * The environment a subject needs for any of this to see anything.
   *
   * Four variables for one value, because tools disagree about which spelling they read. A
   * verifier that set only `HTTPS_PROXY` would observe nothing on a tool that reads
   * `https_proxy`, while still declaring a `net` channel -- which is the shape of lie that makes
   * an implementation look capable and report silence.
   */
  env(): Readonly<Record<string, string>>;
  stop(): Promise<void>;
}

export interface ConnectProxyInput {
  /** Injected, never read from a global: a window's arithmetic must be reproducible. */
  readonly now: () => number;
}

/** What an HTTPS client means by a target with no port. */
const IMPLIED_TLS_PORT = 443;

export function startConnectProxy(input: ConnectProxyInput): Promise<ConnectProxy> {
  const seen: ConnectAttempt[] = [];
  const open = new Set<Socket>();
  const server: Server = createServer((_req, res) => {
    // A plain request reaching a proxy is a tool that did not use CONNECT. Refused rather than
    // forwarded: this is an observer, and quietly becoming a working proxy for cleartext traffic
    // would put it in the path of bytes it has no business carrying.
    res.writeHead(405).end();
  });

  server.on('connect', (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    const { host, port } = parseTarget(req.url ?? '');
    seen.push({ host, port, at: input.now() });

    // Tunnel the bytes through untouched. Nothing here parses, decrypts or stores them: the
    // whole point of this design is that the traffic is none of our business.
    const upstream = connectTcp(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    open.add(clientSocket);
    open.add(upstream);
    const drop = (): void => {
      open.delete(clientSocket);
      open.delete(upstream);
      upstream.destroy();
      clientSocket.destroy();
    };
    // A failure to REACH the far side is still a dial, and it is already recorded above. The
    // attempt is the observation; whether it succeeded is the far side's business, and reporting
    // a refused connection as "never called out" would be the observer's own failure showing up
    // as a fact about the subject.
    upstream.on('error', drop);
    clientSocket.on('error', drop);
    clientSocket.on('close', drop);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = 'object' === typeof address && null !== address ? address.port : 0;
      const url = `http://127.0.0.1:${String(port)}`;
      resolve({
        port,
        connectsSince: (at) => seen.filter((c) => c.at >= at),
        env: () => ({
          HTTPS_PROXY: url,
          https_proxy: url,
          HTTP_PROXY: url,
          http_proxy: url,
        }),
        stop: () =>
          new Promise((done) => {
            for (const socket of open) socket.destroy();
            open.clear();
            server.close(() => done());
          }),
      });
    });
  });
}

/** `host:port`, or a bare host, which an HTTPS client means as port 443. */
function parseTarget(target: string): { host: string; port: number } {
  const at = target.lastIndexOf(':');
  if (-1 === at) return { host: target, port: IMPLIED_TLS_PORT };
  const port = Number(target.slice(at + 1));
  if (!Number.isInteger(port)) return { host: target, port: IMPLIED_TLS_PORT };
  return { host: target.slice(0, at), port };
}
