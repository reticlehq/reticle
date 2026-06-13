import { useState, type FormEvent } from 'react';
import { login } from '../api.js';
import { Colors, Spacing, Typography } from '../design/tokens.js';
import { TestId } from '../constants/index.js';
import { button, card, input } from './styles.js';

export function LoginForm({ onAuth }: { onAuth: (token: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    login(email, password)
      .then((r) => {
        onAuth(r.token);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'login failed');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <main
      style={{
        fontFamily: Typography.fontFamily,
        background: Colors.bg,
        color: Colors.text,
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
      }}
    >
      <form onSubmit={submit} style={{ ...card, width: 320 }} aria-label="Sign in">
        <h1 style={{ fontSize: Typography.fontSize.lg, marginTop: 0 }}>Sign in</h1>
        <label style={{ display: 'block', marginBottom: Spacing.sm }}>
          Email
          <input
            data-testid={TestId.LOGIN_EMAIL}
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
            style={input}
          />
        </label>
        <label style={{ display: 'block', marginBottom: Spacing.md }}>
          Password
          <input
            data-testid={TestId.LOGIN_PASSWORD}
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
            style={input}
          />
        </label>
        <button data-testid={TestId.LOGIN_SUBMIT} type="submit" disabled={busy} style={button}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {error !== null ? (
          <p data-testid={TestId.LOGIN_ERROR} role="alert" style={{ color: Colors.danger }}>
            {error}
          </p>
        ) : null}
        <p style={{ color: Colors.textMuted, fontSize: Typography.fontSize.xs }}>
          Try admin@iris.dev / password
        </p>
      </form>
    </main>
  );
}
