import { iris, SESSION_AUTO, registerCapabilities, registerStore } from '@syrin/iris-browser';

declare const __IRIS_PORT__: number;

/**
 * Large-DOM benchmark fixture. Renders a deliberately large, NON-virtualized grid so a full a11y snapshot
 * costs thousands of tokens — the only place the token wedge shows. Every row carries a real success
 * oracle: clicking "Approve" emits the `row:approved` signal (Tier-1), fires a network request
 * (Tier-2), and mutates the status cell (Tier-3). A targeted verify loop (query one button →
 * act_and_wait → assert the signal) stays a few hundred tokens regardless of grid size — that gap IS
 * the measurement.
 */

const SIGNAL_APPROVED = 'row:approved';
const ENVS = ['prod', 'staging', 'dev', 'canary'] as const;

interface Row {
  id: number;
  name: string;
  env: string;
  approved: boolean;
}

function rowCount(): number {
  const n = Number(new URLSearchParams(window.location.search).get('rows') ?? '800');
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 800;
}

const state = {
  rows: Array.from(
    { length: rowCount() },
    (_, i): Row => ({
      id: i,
      name: `service-${String(i).padStart(4, '0')}`,
      env: ENVS[i % ENVS.length] ?? 'dev',
      approved: false,
    }),
  ),
  approvedCount: 0,
};

function renderGrid(): void {
  const app = document.getElementById('app');
  if (app === null) return;
  const head =
    '<thead><tr><th>ID</th><th>Service</th><th>Env</th><th>Status</th><th>Action</th></tr></thead>';
  const body = state.rows
    .map(
      (r) =>
        `<tr data-testid="row-${r.id}"><td>${r.id}</td><td>${r.name}</td><td>${r.env}</td>` +
        `<td data-testid="status-${r.id}">pending</td>` +
        `<td><button data-testid="approve-${r.id}">Approve</button></td></tr>`,
    )
    .join('');
  app.innerHTML = `<table data-testid="approvals-grid">${head}<tbody>${body}</tbody></table>`;
}

async function approve(id: number): Promise<void> {
  const row = state.rows[id];
  if (row === undefined || row.approved) return;
  // Tier-2: a real network request the agent can assert fired exactly once.
  await fetch(`/?approve=${id}`).catch(() => undefined);
  row.approved = true;
  state.approvedCount += 1;
  // Tier-3: the DOM mutation a presence check would (weakly) read.
  const status = document.querySelector(`[data-testid="status-${id}"]`);
  if (status !== null) {
    status.textContent = 'Approved';
    status.classList.add('approved');
  }
  const counter = document.querySelector('[data-testid="approved-count"]');
  if (counter !== null) counter.textContent = `${state.approvedCount} approved`;
  // Tier-1: the success oracle a wrong/healed element can never fake.
  iris.signal(SIGNAL_APPROVED, { id });
}

function wireDelegation(): void {
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const testid = target.getAttribute('data-testid') ?? '';
    const match = testid.match(/^approve-(\d+)$/);
    if (match?.[1] !== undefined) void approve(Number(match[1]));
  });
}

function installIris(): void {
  const params = new URLSearchParams(window.location.search);
  const present = !params.has('nopresent');
  const session = params.get('session') ?? SESSION_AUTO;
  const irisPort = typeof __IRIS_PORT__ !== 'undefined' ? __IRIS_PORT__ : 4455;
  iris.connect({ session, present, url: `ws://localhost:${irisPort}/iris` });
  registerStore('grid', () => ({
    approvedCount: state.approvedCount,
    rowCount: state.rows.length,
  }));
  registerCapabilities({
    testids: ['grid-title', 'approved-count', 'approvals-grid'],
    signals: [SIGNAL_APPROVED],
    stores: ['grid'],
    flows: [{ name: 'approve-a-row', steps: ['approve-42'] }],
  });
}

renderGrid();
wireDelegation();
installIris();
