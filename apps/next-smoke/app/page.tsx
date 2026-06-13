'use client';
import { useState, useRef } from 'react';
import { iris } from '@syrin/browser';

export default function Page() {
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [reply, setReply] = useState('');
  const [items, setItems] = useState<string[]>(['First task']);
  const [committed, setCommitted] = useState('');
  const [toast, setToast] = useState(false);

  // Commit-on-blur: the value is only saved when the field loses focus (React onBlur).
  const commit = (value: string) => {
    setCommitted(value);
    iris.signal('field:committed', { value });
  };

  // Auto-dismiss toast: appears, then disappears after 4s (a time-gated UI).
  const showToast = () => {
    setToast(true);
    setTimeout(() => {
      setToast(false);
    }, 4000);
  };

  const ping = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ping');
      const data = (await res.json()) as { message: string };
      setReply(data.message);
      setOpen(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={{ padding: 40, maxWidth: 720, margin: '0 auto' }}>
      <h1>Iris Next.js Smoke Test</h1>
      <p style={{ color: '#9aa3b2' }}>
        A real Next.js (app router, React 19, SWC) page wired to Iris.
      </p>

      <section style={{ marginTop: 24, display: 'flex', gap: 8 }}>
        <button data-testid="ping-button" onClick={ping} disabled={loading} style={btn}>
          {loading ? 'Pinging…' : 'Call /api/ping → open modal'}
        </button>
        <button
          data-testid="add-task"
          onClick={() => {
            setItems((p) => [...p, `Task ${p.length + 1}`]);
          }}
          style={btn}
        >
          Add task
        </button>
      </section>

      <ul data-testid="task-list" style={{ marginTop: 16 }}>
        {items.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>

      <section style={{ marginTop: 24 }}>
        <h3>Commit on blur</h3>
        <input
          data-testid="edit-field"
          placeholder="Type, then blur to commit"
          defaultValue=""
          onBlur={(e) => {
            commit(e.target.value);
          }}
          style={{
            padding: 8,
            borderRadius: 8,
            border: '1px solid #2a2f3d',
            background: '#151823',
            color: '#e6e9f0',
          }}
        />
        <p data-testid="committed">Committed: {committed}</p>
      </section>

      <section style={{ marginTop: 24 }}>
        <h3>Auto-dismiss toast</h3>
        <button data-testid="show-toast" onClick={showToast} style={btn}>
          Show toast (auto-dismisses in 4s)
        </button>
        {toast ? (
          <div data-testid="toast" role="status" style={{ marginTop: 8, color: '#22c55e' }}>
            Saved! This toast disappears in 4 seconds.
          </div>
        ) : null}
      </section>

      <section style={{ marginTop: 24 }}>
        <h3>Hover-gated reveal (real-input test)</h3>
        <SmartSentence />
      </section>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Server reply"
          data-testid="reply-modal"
          style={modal}
        >
          <div style={modalInner}>
            <h3 style={{ marginTop: 0 }}>Server replied</h3>
            <p data-testid="reply-text" style={{ fontSize: 24 }}>
              {reply}
            </p>
            <button
              onClick={() => {
                setOpen(false);
              }}
              style={btn}
            >
              Close
            </button>
          </div>
        </div>
      ) : null}
    </main>
  );
}

/**
 * Mirrors AlianPost's smart-sentence: word spans (data-testid="word:<i>") mount only after a
 * real onMouseEnter + a 500ms dwell. Synthetic dispatchEvent can't drive native hover, so this
 * is the fixture that distinguishes synthetic input from real (CDP) input.
 */
function SmartSentence(): React.ReactElement {
  const [revealed, setRevealed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  return (
    <p
      data-testid="smart-sentence"
      style={{ padding: 8, border: '1px dashed #2a2f3d', borderRadius: 8, display: 'inline-block' }}
      onMouseEnter={() => {
        iris.signal('hover:enter', { target: 'smart-sentence' });
        timer.current = setTimeout(() => {
          setRevealed(true);
        }, 500);
      }}
      onMouseLeave={() => {
        if (timer.current !== undefined) clearTimeout(timer.current);
        setRevealed(false);
      }}
    >
      {revealed ? (
        'the quick brown fox'.split(' ').map((w, i) => (
          <span key={w} data-testid={`word:${i}`} style={{ marginRight: 4 }}>
            {w}
          </span>
        ))
      ) : (
        <span data-testid="hover-hint">Hover me to reveal words</span>
      )}
    </p>
  );
}

const btn: React.CSSProperties = {
  padding: '8px 16px',
  borderRadius: 10,
  border: 'none',
  background: '#6366f1',
  color: 'white',
  cursor: 'pointer',
};
const modal: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.5)',
  display: 'grid',
  placeItems: 'center',
};
const modalInner: React.CSSProperties = {
  background: '#151823',
  border: '1px solid #2a2f3d',
  borderRadius: 16,
  padding: 32,
  textAlign: 'center',
};
