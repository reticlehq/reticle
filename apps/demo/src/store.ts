import { create } from 'zustand';

export interface Task {
  id: number;
  title: string;
  done: boolean;
}

interface TaskStore {
  tasks: Task[];
  nextId: number;
  addTask: (title: string) => void;
  toggleTask: (id: number) => void;
}

export const useTasks = create<TaskStore>((set) => ({
  tasks: [],
  nextId: 1,
  addTask: (title) =>
    set((s) => ({
      tasks: [...s.tasks, { id: s.nextId, title, done: false }],
      nextId: s.nextId + 1,
    })),
  toggleTask: (id) =>
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, done: !t.done } : t)),
    })),
}));
