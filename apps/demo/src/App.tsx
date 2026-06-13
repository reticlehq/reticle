import { useEffect } from 'react';
import { useApp } from './store/store.js';
import { Sidebar } from './components/Sidebar.js';
import { Topbar } from './components/Topbar.js';
import { Toasts } from './components/Toasts.js';
import { CommandPalette } from './components/CommandPalette.js';
import { Login } from './components/Login.js';
import { Overview } from './views/Overview.js';
import { Deployments } from './views/Deployments.js';
import { Compose } from './views/Compose.js';
import { Diagnostics } from './views/Diagnostics.js';

export function App(): React.ReactElement {
  const auth = useApp((s) => s.auth);
  const view = useApp((s) => s.view);
  const setPalette = useApp((s) => s.setPalette);

  // ⌘K / Ctrl-K opens the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPalette]);

  if (auth === null) return <Login />;

  return (
    <div className="shell">
      <Sidebar />
      <div className="main">
        <Topbar />
        <div className="content">
          {view === 'overview' ? <Overview /> : null}
          {view === 'deployments' ? <Deployments /> : null}
          {view === 'compose' ? <Compose /> : null}
          {view === 'diagnostics' ? <Diagnostics /> : null}
        </div>
      </div>
      <Toasts />
      <CommandPalette />
    </div>
  );
}
