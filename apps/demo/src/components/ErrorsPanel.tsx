import { useState } from 'react';
import { callBroken, type BrokenKind } from '../api.js';
import { Colors, Spacing, Typography } from '../design/tokens.js';
import { card, row, subtleButton } from './styles.js';

const KINDS: { kind: BrokenKind; label: string }[] = [
  { kind: '404', label: 'GET 404' },
  { kind: '500', label: 'GET 500' },
  { kind: 'cors', label: 'CORS blocked' },
  { kind: 'wrong-format', label: 'Wrong format (HTML not JSON)' },
  { kind: 'wrong-data', label: 'Wrong data (missing fields)' },
];

export function ErrorsPanel({ token }: { token: string }) {
  const [last, setLast] = useState<string | null>(null);

  const trigger = (kind: BrokenKind): void => {
    callBroken(kind, token)
      .then(() => {
        setLast(`${kind}: unexpectedly succeeded`);
      })
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        // Surface to the console so an agent/observability can catch it.
        console.error(`[errors-panel] ${kind} failed:`, message);
        setLast(`${kind}: ${message}`);
      });
  };

  return (
    <section style={card}>
      <h2 style={{ marginTop: 0, fontSize: Typography.fontSize.lg }}>Errors playground</h2>
      <p style={{ color: Colors.textMuted }}>
        Each button triggers a distinct failure mode (network + console errors).
      </p>
      <div style={{ ...row, flexWrap: 'wrap' }}>
        {KINDS.map(({ kind, label }) => (
          <button
            key={kind}
            data-testid={`broken-${kind}`}
            onClick={() => {
              trigger(kind);
            }}
            style={subtleButton}
          >
            {label}
          </button>
        ))}
      </div>
      {last !== null ? (
        <p role="alert" style={{ color: Colors.danger, marginTop: Spacing.md }}>
          {last}
        </p>
      ) : null}
    </section>
  );
}
