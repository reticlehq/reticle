import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { reticle } from '@reticlehq/browser';
import { useApp, type Todo } from './store.js';

const STORAGE_KEY = 'tauri-smoke:last-action';

export function App(): React.ReactElement {
  const { todos, status, route, lastError } = useApp();
  const store = useApp;

  useEffect(() => {
    void invoke<Todo[]>('load_todos').then((loaded) => {
      store.getState().setTodos(loaded);
      store.getState().setStatus(`${String(loaded.length)} todos`);
      reticle.signal('todos:loaded', { count: loaded.length });
    });
  }, [store]);

  const remember = (action: string): void => {
    localStorage.setItem(STORAGE_KEY, action);
  };

  const add = (): void => {
    const draft = (document.getElementById('draft') as HTMLInputElement | null)?.value ?? '';
    void invoke<Todo>('add_todo', { title: draft })
      .then((todo) => {
        store.getState().addTodo(todo);
        store.getState().setStatus('added');
        remember('add');
        reticle.signal('todo:added', { id: todo.id });
      })
      .catch((err: unknown) => {
        store.getState().setStatus('could not add');
        store.getState().setLastError(err instanceof Error ? err.message : String(err));
      });
  };

  /**
   * The planted false green. `archive_todo` always returns Err, but this handler removes the row and
   * writes "archived" first, then swallows the rejection — so the UI, a screenshot, and a DOM
   * assertion all agree the feature works. Only the IPC record disagrees:
   *   reticle_network → ipc://archive_todo  ok:false  status 500
   */
  const archive = (id: number): void => {
    store.getState().removeTodo(id);
    store.getState().setStatus('archived');
    remember('archive');
    void invoke('archive_todo', { id }).catch(() => {
      /* swallowed on purpose — this is the bug Reticle should catch */
    });
  };

  /** Exercises the console observer: an error the UI never shows. */
  const breakSomething = (): void => {
    console.error('checkout total mismatch: expected 42, got 41');
    store.getState().setLastError('checkout total mismatch');
  };

  /**
   * Exercises the route observer without pulling in a router.
   *
   * HASH routing, not `pushState('/settings')`, and that is not a style choice: a packaged desktop
   * renderer runs on `file://`, where pushing an absolute path rewrites the URL to `file:///settings`
   * — a path that does not exist, so the next reload lands on a blank page and the app is gone. This
   * is why HashRouter is the standard choice for packaged Electron/Tauri apps.
   */
  const go = (next: string): void => {
    location.hash = next;
    store.getState().setRoute(next);
  };

  /** A real HTTP call, so the network observer is exercised alongside IPC. */
  const fetchStats = (): void => {
    void fetch('/stats.json')
      .then((res) => res.json())
      .then(() => store.getState().setStatus('stats loaded'))
      .catch(() => store.getState().setStatus('stats failed'));
  };

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 32, maxWidth: 620 }}>
      <style>{`
        @keyframes reticle-pulse { from { opacity: .35 } to { opacity: 1 } }
        .pulse { animation: reticle-pulse 900ms ease-in-out infinite alternate; }
      `}</style>
      <h1>Tauri todos</h1>
      <p data-testid="status">{status}</p>
      <p data-testid="route">route: {route}</p>
      {lastError !== null && (
        <p data-testid="last-error" className="pulse" style={{ color: '#b00' }}>
          {lastError}
        </p>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <input
          id="draft"
          data-testid="draft"
          aria-label="New todo"
          placeholder="What needs doing?"
          style={{ flex: 1, padding: 8 }}
        />
        <button data-testid="add" onClick={add}>
          Add
        </button>
      </div>

      <ul data-testid="todo-list">
        {todos.map((todo) => (
          <li key={todo.id} style={{ margin: '8px 0' }}>
            {todo.title}
            <button
              data-testid={`archive-${String(todo.id)}`}
              onClick={() => archive(todo.id)}
              style={{ marginLeft: 12 }}
            >
              Archive
            </button>
          </li>
        ))}
      </ul>

      <div style={{ display: 'flex', gap: 8, marginTop: 24, flexWrap: 'wrap' }}>
        <button data-testid="break" onClick={breakSomething}>
          Break something
        </button>
        <button data-testid="go-settings" onClick={() => go('#/settings')}>
          Go to settings
        </button>
        <button data-testid="go-home" onClick={() => go('#/')}>
          Go home
        </button>
        <button data-testid="fetch-stats" onClick={fetchStats}>
          Fetch stats
        </button>
      </div>
    </main>
  );
}
