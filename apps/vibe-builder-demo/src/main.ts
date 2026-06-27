/**
 * The instrumented frontend of the "generated" Expense Tracker. This is the one-time integration an
 * AI app-builder adds to its scaffold: import the Iris SDK, expose the app store, and connect to the
 * local bridge in dev. Everything below the `connectIris()` call is ordinary app code.
 *
 * Bug class is read from `?bug=` and forwarded to the API as `x-bug` so the QA agent can exercise a
 * specific silent-failure class. Client-side bug classes (double-submit, wrong-total, console-error)
 * are applied here; server-side ones live in vite.config.ts.
 */
import { iris, registerStore, registerCapabilities } from '@syrin/iris-browser';

interface Expense {
  id: number;
  amount: number;
  category: string;
  note: string;
}

const BUG = new URLSearchParams(location.search).get('bug') ?? 'none';

// The live app store Iris reads via iris_state — the reliable "program truth" layer that pixels miss.
const store = {
  expenses: [] as Expense[],
  get total(): number {
    return this.expenses.reduce((sum, e) => sum + (Number.isNaN(e.amount) ? 0 : e.amount), 0);
  },
};

async function connectIris(): Promise<void> {
  registerStore('app', () => ({ expenses: store.expenses, total: store.total }));
  registerCapabilities({
    testids: ['amount', 'category', 'note', 'add', 'err', 'total', 'list', 'del'],
    stores: ['app'],
  });
  // Ask the preview where its local bridge lives, then connect (dev-only).
  const cfg = (await (await fetch('/api/iris-config')).json()) as { bridgePort: number };
  iris.connect({ url: `ws://localhost:${String(cfg.bridgePort)}/iris`, session: 'preview' });
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

async function load(): Promise<void> {
  const r = await fetch('/api/expenses', { headers: { 'x-bug': BUG } });
  const data = (await r.json()) as { expenses: Expense[] };
  store.expenses = data.expenses;
  render();
}

function render(): void {
  $('list').innerHTML = store.expenses
    .map(
      (e) =>
        `<li>${e.category} — ${String(e.amount)} <button data-id="${String(e.id)}" data-testid="del">x</button></li>`,
    )
    .join('');
  // BUG wrong-total: the displayed Total lies versus the data.
  $('total').textContent = String(store.total + (BUG === 'wrong-total' ? 1 : 0));
}

function wire(): void {
  $<HTMLFormElement>('add').addEventListener('submit', (ev) => {
    void (async (): Promise<void> => {
      ev.preventDefault();
      $('err').textContent = '';
      const payload = {
        amount: $<HTMLInputElement>('amount').value,
        category: $<HTMLSelectElement>('category').value,
        note: $<HTMLInputElement>('note').value,
      };
      const post = (): Promise<Response> =>
        fetch('/api/expenses', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-bug': BUG },
          body: JSON.stringify(payload),
        });
      const res = await post();
      // BUG double-submit: the same POST fires twice.
      if (BUG === 'double-submit') await post();
      if (!res.ok) {
        const e = (await res.json()) as { error?: string };
        $('err').textContent = e.error ?? 'failed';
        return;
      }
      // BUG console-error: log an error even though the UI proceeds as if fine.
      if (BUG === 'console-error') console.error('[preview] post-add invariant check failed');
      $<HTMLInputElement>('amount').value = '';
      $<HTMLInputElement>('note').value = '';
      await load();
    })();
  });

  $('list').addEventListener('click', (ev) => {
    void (async (): Promise<void> => {
      const id = (ev.target as HTMLElement).getAttribute('data-id');
      if (id === null) return;
      await fetch(`/api/expenses/${id}`, { method: 'DELETE', headers: { 'x-bug': BUG } });
      await load();
    })();
  });
}

// Only connect to the bridge when the QA harness drives this page (?iris=1). A plain preview (e.g.
// embedded in the builder UI's iframe) stays a pure, uninstrumented view — so it never races the
// harness's own browser for the session, and never spams connection attempts when no bridge is up.
if (new URLSearchParams(location.search).get('iris') === '1') void connectIris();
wire();
void load();
