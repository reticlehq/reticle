import { useState } from 'react';
import { generateScript } from '../api.js';
import { Colors, Spacing, Typography } from '../design/tokens.js';
import { button, card, input } from './styles.js';
import { TestId } from '../constants/index.js';

export function ScriptPanel({ token }: { token: string }) {
  const [prompt, setPrompt] = useState('a 15-second video about coffee');
  const [script, setScript] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const generate = (): void => {
    setBusy(true);
    setScript(null);
    generateScript(token, prompt)
      .then((r) => {
        setScript(r.script);
      })
      .catch((e: unknown) => {
        console.error('generate failed', e);
        setScript(`Error: ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <section style={card}>
      <h2 style={{ marginTop: 0, fontSize: Typography.fontSize.lg }}>Generate a script (LLM)</h2>
      <input
        data-testid={TestId.SCRIPT_PROMPT}
        value={prompt}
        onChange={(e) => {
          setPrompt(e.target.value);
        }}
        style={input}
      />
      <button
        data-testid={TestId.GENERATE_BUTTON}
        onClick={generate}
        disabled={busy}
        style={{ ...button, marginTop: Spacing.sm }}
      >
        {busy ? 'Generating…' : 'Generate'}
      </button>
      {script !== null ? (
        <pre
          data-testid={TestId.SCRIPT_OUTPUT}
          style={{
            marginTop: Spacing.md,
            whiteSpace: 'pre-wrap',
            background: Colors.bg,
            border: `1px solid ${Colors.border}`,
            borderRadius: 8,
            padding: Spacing.md,
            color: Colors.text,
          }}
        >
          {script}
        </pre>
      ) : null}
    </section>
  );
}
