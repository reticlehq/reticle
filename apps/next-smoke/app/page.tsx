'use client';
import { useState } from 'react';

export default function Page() {
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [reply, setReply] = useState('');
  const [items, setItems] = useState<string[]>(['First task']);

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
