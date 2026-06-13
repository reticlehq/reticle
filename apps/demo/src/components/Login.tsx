import { useState } from 'react';
import { useApp } from '../store/store.js';
import { login } from '../lib/api.js';
import { emit, Sig } from '../lib/iris-bridge.js';
import { IconArrow } from './icons.js';

/** Sign-in splash. Real POST /api/login (auth + network showcase). Pre-filled for a one-click demo. */
export function Login(): React.ReactElement {
  const setAuth = useApp((s) => s.setAuth);
  const [email, setEmail] = useState('admin@iris.dev');
  const [password, setPassword] = useState('password');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError('');
    const { ok } = await login(email, password);
    setBusy(false);
    if (ok) {
      setAuth(email);
    } else {
      setError('Invalid email or password');
      emit(Sig.AUTH_DENIED, { email });
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="panel panel-pad view" style={{ width: 380, padding: 32 }}>
        <div className="row" style={{ gap: 12, marginBottom: 4 }}>
          <div className="brand-glyph" />
          <div>
            <div className="brand-name" style={{ fontSize: 20 }}>
              Iris
            </div>
            <div className="brand-sub">mission control</div>
          </div>
        </div>
        <h2 style={{ fontSize: 22, margin: '22px 0 6px' }}>Welcome back</h2>
        <p style={{ color: 'var(--muted)', margin: '0 0 22px', fontSize: 13.5 }}>
          Sign in to your deployment console.
        </p>

        <label className="label" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          className="field"
          data-testid="login-email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <label className="label" htmlFor="password" style={{ marginTop: 14 }}>
          Password
        </label>
        <input
          id="password"
          type="password"
          className="field"
          data-testid="login-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
        />

        {error !== '' ? (
          <div
            data-testid="login-error"
            style={{ color: 'var(--danger)', fontSize: 12.5, marginTop: 12 }}
          >
            {error}
          </div>
        ) : null}

        <button
          type="button"
          className="btn btn-primary"
          data-testid="login-submit"
          onClick={() => void submit()}
          disabled={busy}
          style={{ width: '100%', justifyContent: 'center', marginTop: 22 }}
        >
          {busy ? 'Signing in…' : 'Sign in'} <IconArrow size={15} />
        </button>
      </div>
    </div>
  );
}
