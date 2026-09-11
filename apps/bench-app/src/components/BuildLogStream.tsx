import { useEffect, useRef, useState } from 'react';

/**
 * Streams fixture: an SSE build log and a WebSocket echo.
 *
 * These exist because a stream failure is invisible to everything that inspects a moment. The request
 * is open and healthy, the DOM is rendered and correct, nothing throws — the app is simply told
 * nothing, or told something it silently drops. Only the frame timeline shows it.
 *
 * Reticle captures SSE/WS frames as NET_STREAM events, but ONLY when the SDK is connected with
 * `captureNetworkBodies` — a chatty stream is the high-volume case, so it is opt-in.
 */

const STREAM_STATUS_TESTID = 'stream-status';
const STREAM_STEPS_TESTID = 'stream-steps';
const WS_STATUS_TESTID = 'ws-status';
const WS_SEND_TESTID = 'ws-send';

/** Overridable so the injector can point the app at a deliberately broken stream. */
export const STREAM_URLS = {
  // Absolute, like lib/api.ts: a relative URL resolves against the VITE dev server (4312), not the
  // API (8787), so the stream connects to something that serves no frames at all.
  sse: 'http://localhost:8787/api/build-log',
  ws: 'ws://localhost:8787/ws/echo',
};

const STREAMING_LABEL = 'streaming…';
const DONE_LABEL = 'build complete';
/** The channel this client subscribes to — a reply on any other channel must not count. */
const WS_CHANNEL = 'deployments';

export function BuildLogStream(): React.ReactElement {
  const [steps, setSteps] = useState<string[]>([]);
  const [status, setStatus] = useState(STREAMING_LABEL);
  const [wsStatus, setWsStatus] = useState('idle');
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const source = new EventSource(STREAM_URLS.sse);
    source.addEventListener('message', (ev) => {
      // A malformed frame is DROPPED silently — no throw, no console error. That is the bug: the log
      // is quietly incomplete and the UI looks like it is still working.
      try {
        const frame: unknown = JSON.parse(String(ev.data));
        const step =
          'object' === typeof frame && frame !== null && 'step' in frame ? String(frame.step) : '';
        if (0 === step.length) return;
        setSteps((prev) => [...prev, step]);
        if (step === DONE_LABEL) setStatus(DONE_LABEL);
      } catch {
        /* unparseable frame: dropped, exactly as a real client would */
      }
    });
    return () => source.close();
  }, []);

  useEffect(() => {
    const socket = new WebSocket(STREAM_URLS.ws);
    socketRef.current = socket;
    socket.addEventListener('message', (ev) => {
      try {
        const reply: unknown = JSON.parse(String(ev.data));
        const channel =
          'object' === typeof reply && reply !== null && 'channel' in reply
            ? String(reply.channel)
            : '';
        // A reply on a channel we never subscribed to is ignored — so the UI simply never updates.
        if (channel === WS_CHANNEL) setWsStatus('synced');
      } catch {
        /* ignore */
      }
    });
    return () => socket.close();
  }, []);

  return (
    <div className="card" style={{ display: 'grid', gap: 8 }}>
      <div className="card-title">Build log</div>
      <div data-testid={STREAM_STATUS_TESTID}>{status}</div>
      <div data-testid={STREAM_STEPS_TESTID} className="mono" style={{ fontSize: 12 }}>
        {steps.join(' · ')}
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button
          type="button"
          className="btn"
          data-testid={WS_SEND_TESTID}
          onClick={() =>
            socketRef.current?.send(JSON.stringify({ channel: WS_CHANNEL, want: 'status' }))
          }
        >
          Sync deployments
        </button>
        <span data-testid={WS_STATUS_TESTID}>{wsStatus}</span>
      </div>
    </div>
  );
}
