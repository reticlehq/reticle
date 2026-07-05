import { useState } from 'react';
import { signal } from './reticle';
import { useTasks } from './store';

export function App() {
  const [draft, setDraft] = useState('');
  const tasks = useTasks((s) => s.tasks);
  const addTask = useTasks((s) => s.addTask);
  const toggleTask = useTasks((s) => s.toggleTask);

  const submit = () => {
    const title = draft.trim();
    if (!title) return;
    addTask(title);
    signal('task:added', { title });
    setDraft('');
  };

  const remaining = tasks.filter((t) => !t.done).length;

  return (
    <main className="app">
      <h1>Reticle Demo</h1>
      <p className="count" data-testid="remaining-count">
        {remaining} task{remaining === 1 ? '' : 's'} remaining
      </p>

      <div className="add-row">
        <input
          data-testid="task-input"
          value={draft}
          placeholder="What needs doing?"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <button data-testid="add-task" onClick={submit}>
          Add
        </button>
      </div>

      <ul className="list">
        {tasks.map((t) => (
          <li key={t.id} className={t.done ? 'done' : ''}>
            <label>
              {/* Key the testid off the title, not the incrementing id: a recorded flow controls
                  the title it types, so `toggle-${title}` is a replay-stable anchor; `toggle-${id}`
                  is not (ids never repeat, so the recorded id is gone on the next run). */}
              <input
                type="checkbox"
                checked={t.done}
                data-testid={`toggle-${t.title}`}
                onChange={() => {
                  toggleTask(t.id);
                  signal('task:toggled', { id: t.id });
                }}
              />
              {t.title}
            </label>
          </li>
        ))}
      </ul>
    </main>
  );
}
