import { useEffect } from 'react';
import { reticle } from '@reticlehq/browser';
import { useApp, type Todo } from './store.js';

/** The preload's contextBridge surface. Every call here is a main-process round trip, not HTTP. */
interface DesktopApi {
  loadTodos: () => Promise<Todo[]>;
  addTodo: (title: string) => Promise<Todo>;
  archiveTodo: (id: number) => Promise<void>;
  bulkDone: (ids: number[]) => Promise<{ requested: number }>;
  /** One-way `ipcRenderer.send` — returns nothing, and no reply ever comes back. */
  markSeen: (id: number) => void;
}

function api(): DesktopApi {
  return (window as unknown as { api: DesktopApi }).api;
}

const STORAGE_KEY = 'electron-smoke:last-action';

export function App(): React.ReactElement {
  const { todos, status, route, lastError } = useApp();
  const store = useApp;

  useEffect(() => {
    void api()
      .loadTodos()
      .then((loaded) => {
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
    void api()
      .addTodo(draft)
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
   * The planted false green. The IPC call ALWAYS rejects, but this handler updates the list and the
   * status line first and swallows the error — so the screen reads "archived" and a screenshot, a DOM
   * assertion, and a human glance all agree the feature works. Only the IPC record disagrees:
   *   reticle_network → ipc://todos:archive  ok:false  "archive is not implemented in the backend"
   */
  const archive = (id: number): void => {
    store.getState().removeTodo(id);
    store.getState().setStatus('archived');
    remember('archive');
    void api()
      .archiveTodo(id)
      .catch(() => {
        /* swallowed on purpose — this is the bug Reticle should catch */
      });
  };

  /**
   * A one-way `ipcRenderer.send`. There is no promise to await and no reply channel, so the UI
   * cannot know whether the main process handled it — and neither can Reticle. The call still has
   * to be VISIBLE, or an app built on this pattern reports no backend activity at all.
   */
  const markSeen = (): void => {
    api().markSeen(todos[0]?.id ?? 0);
    store.getState().setStatus('marked seen');
  };

  /** Exercises the console observer: an uncaught error the UI never shows. */
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
      <h1>Electron todos</h1>
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
        <button
          data-testid="bulk-done"
          onClick={() => {
            // Trusts the envelope: the promise resolved, so the banner reports the count REQUESTED.
            // The per-item outcomes inside the payload are never read — which is how a bulk action is
            // written in every desktop app anyone has shipped.
            const ids = todos.map((t) => t.id);
            void api()
              .bulkDone(ids)
              .then(() => {
                store.getState().setStatus(`${String(ids.length)} marked done`);
              })
              .catch(() => {
                store.getState().setStatus('bulk failed');
              });
          }}
        >
          Bulk done
        </button>
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
        <button data-testid="mark-seen" onClick={markSeen}>
          Mark seen (one-way)
        </button>
      </div>
    </main>
  );
}
