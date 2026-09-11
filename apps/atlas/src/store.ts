import { create } from 'zustand';

/**
 * Atlas keeps its truth in three places that can disagree, on purpose.
 *
 *  - this store: what the LIST believes
 *  - the lifecycle machine (`machine.ts`): what the SHIPMENT believes about itself
 *  - the server: what actually happened, arriving later over SSE
 *
 * Real consoles are built exactly this way, and the interesting failures live in the gaps: a row
 * that says `dispatched` because the client was optimistic, a machine still in `dispatching`, and a
 * server that reverted it to `held` a second later. No single channel can catch that.
 */

export interface Leg {
  id: string;
  from: string;
  to: string;
  status: string;
  etaMinutes: number;
}

export interface Shipment {
  id: string;
  ref: string;
  carrier: string;
  origin: string;
  destination: string;
  status: string;
  weightGrams: number;
  declaredValueMinor: number;
  currency: string;
  legs: Leg[];
  updatedAt: number;
  version: number;
}

interface AtlasState {
  rows: Shipment[];
  total: number;
  page: number;
  size: number;
  status: string;
  search: string;
  loading: boolean;
  /** Shipments the client optimistically marked dispatched, awaiting the server's verdict. */
  pendingDispatch: string[];
  lastError: string | null;
  selected: string[];
  setRows: (rows: Shipment[], total: number, page: number) => void;
  setLoading: (loading: boolean) => void;
  setStatus: (status: string) => void;
  setSearch: (search: string) => void;
  setPage: (page: number) => void;
  optimisticDispatch: (id: string) => void;
  applyServerVersion: (id: string, version: number, status?: string) => void;
  toggleSelected: (id: string) => void;
  setError: (message: string | null) => void;
}

export const useAtlas = create<AtlasState>((set) => ({
  rows: [],
  total: 0,
  page: 1,
  size: 50,
  status: 'all',
  search: '',
  loading: false,
  pendingDispatch: [],
  lastError: null,
  selected: [],
  setRows: (rows, total, page) => set({ rows, total, page, loading: false }),
  setLoading: (loading) => set({ loading }),
  // NOTE: changing the filter does not reset `page`. Written the way it usually is written — the
  // filter control knows nothing about the paginator — rather than as a planted defect.
  setStatus: (status) => set({ status }),
  setSearch: (search) => set({ search }),
  setPage: (page) => set({ page }),
  optimisticDispatch: (id) =>
    set((s) => ({
      rows: s.rows.map((r) => (r.id === id ? { ...r, status: 'dispatched' } : r)),
      pendingDispatch: [...s.pendingDispatch, id],
    })),
  applyServerVersion: (id, version, status) =>
    set((s) => ({
      rows: s.rows.map((r) =>
        r.id === id ? { ...r, version, ...(status === undefined ? {} : { status }) } : r,
      ),
      pendingDispatch: s.pendingDispatch.filter((p) => p !== id),
    })),
  toggleSelected: (id) =>
    set((s) => ({
      selected: s.selected.includes(id) ? s.selected.filter((x) => x !== id) : [...s.selected, id],
    })),
  setError: (message) => set({ lastError: message }),
}));
