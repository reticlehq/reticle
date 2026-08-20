import { create } from 'zustand';
import { clearSession, newSession, persistSession } from '../lib/persisted-session.js';
import { isEnterpriseEnabled } from '../lib/enterprise-config.js';
import { emit, Sig } from '../lib/reticle-bridge.js';
import {
  seedActivity,
  seedDeployments,
  seedKpis,
  seedSeries,
  type ActivityItem,
  type Deployment,
  type Env,
  type Kpi,
} from '../data/seed.js';

export type ViewId =
  'overview' | 'deployments' | 'compose' | 'diagnostics' | 'hostile' | 'enterprise' | 'saved-items';
export type EnvFilter = Env | 'all';

export interface Toast {
  id: number;
  tone: 'success' | 'danger' | 'info';
  title: string;
  detail?: string;
}

interface RequestLog {
  id: number;
  method: string;
  path: string;
  status: number | 'ERR';
  ms: number;
  ok: boolean;
}

interface AppState {
  view: ViewId;
  auth: { email: string } | null;
  deployments: Deployment[];
  kpis: Kpi[];
  activity: ActivityItem[];
  series: number[];
  filter: { query: string; env: EnvFilter };
  selectedId: number | null;
  drawerId: number | null;
  newDeployOpen: boolean;
  paletteOpen: boolean;
  toasts: Toast[];
  requestLog: RequestLog[];
  compose: { title: string; prompt: string; result: string; generating: boolean };
  savedItems: { id: number; label: string; savedAt: string }[];
  savedItemsStatus: 'idle' | 'saving' | 'error';
  saveItem: (label: string, renderDelayMs?: number) => Promise<void>;

  setView: (v: ViewId) => void;
  setAuth: (email: string) => void;
  signOut: () => void;
  setFilter: (patch: Partial<{ query: string; env: EnvFilter }>) => void;
  select: (id: number | null) => void;
  openDrawer: (id: number) => void;
  closeDrawer: () => void;
  setNewDeploy: (open: boolean) => void;
  setPalette: (open: boolean) => void;
  createDeployment: (service: string, env: Env) => void;
  shipDeployment: (id: number) => void;
  reorder: (id: number, dir: -1 | 1) => void;
  pushToast: (t: Omit<Toast, 'id'>) => void;
  dismissToast: (id: number) => void;
  logRequest: (r: Omit<RequestLog, 'id'>) => void;
  setCompose: (patch: Partial<AppState['compose']>) => void;
}

let toastSeq = 1;
let logSeq = 1;
let depSeq = 9000;

export const useApp = create<AppState>((set, get) => ({
  // The enterprise-scale fixture boots straight into its view when its URL knob is present, so a
  // benchmark reaches it in one navigation. Every other URL is untouched.
  view: isEnterpriseEnabled() ? 'enterprise' : 'overview',
  auth: null,
  deployments: seedDeployments(),
  kpis: seedKpis(),
  activity: seedActivity(),
  series: seedSeries(),
  filter: { query: '', env: 'all' },
  selectedId: null,
  drawerId: null,
  newDeployOpen: false,
  paletteOpen: false,
  toasts: [],
  requestLog: [],
  compose: { title: '', prompt: '', result: '', generating: false },
  savedItems: [],
  savedItemsStatus: 'idle',
  saveItem: async (label, renderDelayMs = 0) => {
    // Do NOT set savedItemsStatus:'saving' here — that STATE_CHANGE fires before the response
    // lands and makes uiAdvanced()=true, which suppresses response-ignored in both polarities.
    // The fixture must stay state-quiet until the response is read.
    try {
      const res = await fetch('http://localhost:8787/api/saved-items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label }),
      });
      const data = (await res.json()) as { id?: number; label?: string; savedAt?: string };
      if ('number' === typeof data.id && 'string' === typeof data.label) {
        const item = { id: data.id, label: data.label, savedAt: data.savedAt ?? '' };
        if (0 >= renderDelayMs) {
          // Correct: state update is synchronous with the response — same microtask.
          set({ savedItems: [...get().savedItems, item] });
          emit(Sig.ITEM_SAVED, { id: item.id, label: item.label });
        } else {
          // Broken: response arrived but render deferred. The function returns here — BEFORE
          // the render fires — so act_and_wait sees the POST settle with no state movement.
          // After the 300ms grace elapses with nothing moved, response-ignored fires.
          // The setTimeout is fire-and-forget: saveItem resolves NOW, not after the delay.
          setTimeout(() => {
            set({ savedItems: [...get().savedItems, item] });
            emit(Sig.ITEM_SAVED, { id: item.id, label: item.label });
          }, renderDelayMs);
          return; // return immediately — the delayed render is fire-and-forget
        }
      }
      // Dropped-response variant: server returned 200 OK but no id — write silently lost.
    } catch {
      set({ savedItemsStatus: 'error' });
    }
  },

  setView: (view) => {
    set({ view });
    emit(Sig.NAV_CHANGED, { view });
    // Deep-linkable views: reflect the active view in the URL path so navigation emits a real
    // route change (Reticle reads route changes as the "which page" of each journey step). The query
    // string is preserved so dev-only knobs like ?reticle-break= survive navigation.
    const target = `/${view}`;
    if (typeof history !== 'undefined' && location.pathname !== target) {
      history.pushState({}, '', `${target}${location.search}`);
    }
  },
  setAuth: (email) => {
    set({ auth: { email } });
    // Persist BEFORE announcing: a listener that reloads on auth:granted must find the token there.
    persistSession(newSession());
    emit(Sig.AUTH_GRANTED, { email });
  },
  signOut: () => {
    set({ auth: null, view: 'overview' });
    clearSession();
  },
  setFilter: (patch) => {
    set({ filter: { ...get().filter, ...patch } });
    emit(Sig.FILTER_CHANGED, get().filter);
  },
  select: (selectedId) => {
    set({ selectedId });
    if (selectedId !== null) emit(Sig.DEPLOY_SELECTED, { id: selectedId });
  },
  openDrawer: (drawerId) => {
    set({ drawerId, selectedId: drawerId });
    emit(Sig.DRAWER_OPENED, { id: drawerId });
  },
  closeDrawer: () => set({ drawerId: null }),
  setNewDeploy: (newDeployOpen) => {
    set({ newDeployOpen });
    emit(newDeployOpen ? Sig.MODAL_OPENED : Sig.MODAL_CLOSED, { modal: 'new-deploy' });
  },
  setPalette: (paletteOpen) => {
    set({ paletteOpen });
    if (paletteOpen) emit(Sig.PALETTE_OPENED, {});
  },
  createDeployment: (service, env) => {
    const id = depSeq++;
    const dep: Deployment = {
      id,
      service,
      env,
      status: 'building',
      region: 'us-east-1',
      durationMs: 0,
      author: get().auth?.email.split('@')[0] ?? 'you',
      commit: id.toString(16).slice(0, 7),
      createdAt: 'just now',
      // Never rendered — a fresh deploy is not yet costed (0) and its checksum mirrors the commit.
      costUsd: 0,
      checksum: id.toString(16).slice(0, 7),
    };
    // Optimistic: the row is in the store immediately (state) before it "settles" in the UI.
    set({ deployments: [dep, ...get().deployments] });
    emit(Sig.DEPLOY_CREATED, { id, service, env });
    get().pushToast({ tone: 'info', title: `Deploying ${service}`, detail: `${env} · queued` });
    // Builds, then goes live after a beat (time-gated — reticle_clock can fast-forward this).
    setTimeout(() => {
      set({
        deployments: get().deployments.map((d) => (d.id === id ? { ...d, status: 'live' } : d)),
      });
      get().pushToast({
        tone: 'success',
        title: `${service} is live`,
        detail: `${env} · us-east-1`,
      });
      emit(Sig.DEPLOY_SHIPPED, { id, service, env });
    }, 2600);
  },
  shipDeployment: (id) => {
    const dep = get().deployments.find((d) => d.id === id);
    set({
      deployments: get().deployments.map((d) => (d.id === id ? { ...d, status: 'live' } : d)),
    });
    emit(Sig.DEPLOY_SHIPPED, { id, service: dep?.service });
    get().pushToast({
      tone: 'success',
      title: `Shipped ${dep?.service ?? id}`,
      detail: 'now live',
    });
  },
  reorder: (id, dir) => {
    const list = [...get().deployments];
    const i = list.findIndex((d) => d.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    const a = list[i];
    const b = list[j];
    if (a === undefined || b === undefined) return;
    list[i] = b;
    list[j] = a;
    set({ deployments: list });
    emit(Sig.DEPLOY_REORDERED, { id, dir });
  },
  pushToast: (t) => {
    const toast: Toast = { ...t, id: toastSeq++ };
    set({ toasts: [...get().toasts, toast] });
    emit(Sig.TOAST_SHOWN, { tone: toast.tone, title: toast.title });
    setTimeout(() => get().dismissToast(toast.id), 4200);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  logRequest: (r) =>
    set({ requestLog: [{ ...r, id: logSeq++ }, ...get().requestLog].slice(0, 40) }),
  setCompose: (patch) => set({ compose: { ...get().compose, ...patch } }),
}));
