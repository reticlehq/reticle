// The WebSocket market feed. It attaches to the Vite HTTP server on STREAM_PATH, so one process
// serves both. The client sets the tick rate with `?rate=N` (messages a second, 0 = off).
import { WebSocketServer } from 'ws';

export const STREAM_PATH = '/stream';
const SYMBOLS = ['AAPL', 'MSFT', 'GOOG', 'AMZN', 'NVDA', 'META', 'TSLA', 'NFLX'];
const BATCH_MS = 10;
const ACK_DELAY_MS = 100;
const ORDER = 'order';

function startTicker(socket, rate) {
  if (rate <= 0) {
    return () => {};
  }
  // ponytail: one timer sends rate/100 frames each 10 ms. Node timers cannot fire 5,000 times a second.
  const perBatch = rate * (BATCH_MS / 1000);
  let owed = 0;
  let seq = 0;
  const timer = setInterval(() => {
    owed += perBatch;
    while (owed >= 1 && socket.readyState === socket.OPEN) {
      owed -= 1;
      seq += 1;
      const s = SYMBOLS[seq % SYMBOLS.length];
      socket.send(JSON.stringify({ t: 'tick', s, p: (100 + Math.sin(seq) * 5).toFixed(2), seq }));
    }
  }, BATCH_MS);
  return () => clearInterval(timer);
}

function onOrder(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (msg.t !== ORDER) {
    return;
  }
  setTimeout(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ t: 'ack', orderId: msg.orderId, status: 'filled' }));
    }
  }, ACK_DELAY_MS);
}

export function streamPlugin() {
  return {
    name: 'trading-stream',
    configureServer(server) {
      const wss = new WebSocketServer({ noServer: true });
      server.httpServer?.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname !== STREAM_PATH) {
          return;
        }
        const rate = Number(url.searchParams.get('rate') ?? '0');
        wss.handleUpgrade(req, socket, head, (ws) => {
          const stop = startTicker(ws, Number.isFinite(rate) ? rate : 0);
          ws.on('close', stop);
          ws.on('message', (raw) => onOrder(ws, raw));
        });
      });
    },
  };
}
