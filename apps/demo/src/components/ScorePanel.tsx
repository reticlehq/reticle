import { useState } from 'react';
import { scoreFile } from '../api.js';
import { Colors, Radius, Spacing, Shadow, Typography } from '../design/tokens.js';
import { button, card, subtleButton } from './styles.js';
import { TestId } from '../constants/index.js';

interface Result {
  filename: string;
  score: number;
  verdict: string;
}

export function ScorePanel({ token }: { token: string }) {
  const [filename, setFilename] = useState<string | null>(null);
  const [size, setSize] = useState(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const analyze = (): void => {
    if (filename === null) return;
    setBusy(true);
    scoreFile(token, filename, size)
      .then((r) => {
        setResult({ filename, score: r.score, verdict: r.verdict });
      })
      .catch((e: unknown) => {
        console.error('score failed', e);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <section style={card}>
      <h2 style={{ marginTop: 0, fontSize: Typography.fontSize.lg }}>
        Score a file (upload → LLM)
      </h2>
      <input
        data-testid={TestId.FILE_INPUT}
        type="file"
        aria-label="File to score"
        onChange={(e) => {
          const file = e.target.files?.[0];
          setFilename(file?.name ?? null);
          setSize(file?.size ?? 0);
        }}
        style={{ color: Colors.textMuted }}
      />
      <button
        data-testid={TestId.ANALYZE_BUTTON}
        onClick={analyze}
        disabled={busy || filename === null}
        style={{ ...button, marginLeft: Spacing.sm }}
      >
        {busy ? 'Analyzing…' : 'Analyze'}
      </button>

      {result !== null ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Score result"
          data-testid={TestId.SCORE_MODAL}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'grid',
            placeItems: 'center',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              background: Colors.surface,
              border: `1px solid ${Colors.border}`,
              borderRadius: Radius.lg,
              boxShadow: Shadow.lg,
              padding: Spacing.xl,
              minWidth: 280,
              textAlign: 'center',
            }}
          >
            <h3 style={{ marginTop: 0 }}>Score for {result.filename}</h3>
            <p data-testid={TestId.SCORE_VALUE} style={{ fontSize: Typography.fontSize.xl }}>
              {result.score} / 100
            </p>
            <p style={{ color: Colors.textMuted }}>{result.verdict}</p>
            <button
              onClick={() => {
                setResult(null);
              }}
              style={subtleButton}
            >
              Close
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
