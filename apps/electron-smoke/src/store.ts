import { create } from 'zustand';

export interface Todo {
  id: number;
  title: string;
  done: boolean;
}

/**
 * The app's real state, in a store Reticle can read live via `reticle_state` — the reliable layer.
 * A DOM assertion can be faked by a healed selector; the store cannot.
 */
interface AppState {
  todos: Todo[];
  status: string;
  route: string;
  lastError: string | null;
  setTodos: (todos: Todo[]) => void;
  addTodo: (todo: Todo) => void;
  removeTodo: (id: number) => void;
  setStatus: (status: string) => void;
  setRoute: (route: string) => void;
  setLastError: (message: string | null) => void;
}

export const useApp = create<AppState>((set) => ({
  todos: [],
  status: 'loading',
  route: '/',
  lastError: null,
  setTodos: (todos) => set({ todos }),
  addTodo: (todo) => set((s) => ({ todos: [...s.todos, todo] })),
  removeTodo: (id) => set((s) => ({ todos: s.todos.filter((t) => t.id !== id) })),
  setStatus: (status) => set({ status }),
  setRoute: (route) => set({ route }),
  setLastError: (lastError) => set({ lastError }),
}));
