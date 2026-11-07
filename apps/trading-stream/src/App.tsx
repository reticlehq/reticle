import { useEffect, useRef, useState } from 'react';
import { reticle } from '@reticlehq/browser';

const SYMBOLS = ['AAPL', 'MSFT', 'GOOG', 'AMZN', 'NVDA', 'META', 'TSLA', 'NFLX'];
const FILLED = 'Filled';
const PENDING = 'Pending';
const SIGNAL_FILLED = 'order.filled';
const TICK = 'tick';
const ACK = 'ack';

type Order = { orderId: string; status: string };
type Frame = { t: string; s?: string; p?: string; orderId?: string; status?: string };

function streamUrl(): string {
  const rate = new URLSearchParams(location.search).get('rate') ?? '0';
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/stream?rate=${encodeURIComponent(rate)}`;
}

export function App() {
  const socket = useRef<WebSocket | null>(null);
  const cells = useRef(new Map<string, HTMLSpanElement>());
  const last = useRef(new Map<string, number>());
  const next = useRef(1);
  const [orders, setOrders] = useState<Order[]>([]);

  useEffect(() => {
    const ws = new WebSocket(streamUrl());
    socket.current = ws;
    ws.onmessage = (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data)) as Frame;
      if (msg.t === TICK && msg.s !== undefined && msg.p !== undefined) {
        // A real ticker writes the cell directly: one text change and one class flash per tick.
        const cell = cells.current.get(msg.s);
        const price = Number(msg.p);
        if (cell) {
          cell.textContent = `${msg.s} ${msg.p}`;
          cell.className = `cell ${price >= (last.current.get(msg.s) ?? 0) ? 'up' : 'down'}`;
        }
        last.current.set(msg.s, price);
      } else if (msg.t === ACK && msg.orderId !== undefined) {
        const orderId = msg.orderId;
        setOrders((all) => all.map((o) => (o.orderId === orderId ? { ...o, status: FILLED } : o)));
        reticle.signal(SIGNAL_FILLED, { orderId, status: msg.status });
      }
    };
    return () => ws.close();
  }, []);

  const buy = () => {
    const orderId = `o-${String(next.current)}`;
    next.current += 1;
    setOrders((all) => [...all, { orderId, status: PENDING }]);
    socket.current?.send(JSON.stringify({ t: 'order', orderId, side: 'buy', qty: 1 }));
  };

  return (
    <main>
      <h1>Trading stream</h1>
      <div>
        {SYMBOLS.map((s) => (
          <span
            key={s}
            className="cell"
            ref={(el) => {
              if (el) {
                cells.current.set(s, el);
              }
            }}
          >
            {s} --
          </span>
        ))}
      </div>
      <button data-testid="buy" onClick={buy}>
        Buy
      </button>
      <ul>
        {orders.map((o) => (
          <li key={o.orderId} data-testid={`order-${o.orderId}`}>
            {o.orderId} {o.status}
          </li>
        ))}
      </ul>
    </main>
  );
}
