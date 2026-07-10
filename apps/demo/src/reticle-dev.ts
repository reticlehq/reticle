// Dev-only Reticle wiring. Imported from main.tsx inside an import.meta.env.DEV guard.
// The vite reticle() plugin already injects reticle.connect(); here we register the app's
// testable surface (testids, signals, stores) so the agent knows what it can drive and read.
import { registerCapabilities, registerStore } from '@reticlehq/react';
import { useTasks } from './store';

registerStore('tasks', () => useTasks.getState());

registerCapabilities({
  testids: ['task-input', 'add-task', 'remaining-count'],
  signals: ['task:added', 'task:toggled'],
  stores: ['tasks'],
});
