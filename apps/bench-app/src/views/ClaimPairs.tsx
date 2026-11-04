import { useEffect, useState } from 'react';

/**
 * The shapes of two claims that a real browser must verify, and their controls (#2176).
 *
 *  - A route claim: a click that does a full navigation to a new route, with a `route` predicate
 *    that passes (`yes`), and a click on an inert button with a `settled` wait (not `yes`).
 *  - An absence claim beside a virtualized list: closing a dialog, then the dialog asserted absent
 *    by testid (`yes`), and a row of the list that is not rendered asserted absent (`unknown`).
 */
const API = 'http://localhost:8787/api/claim-pairs';
/** The route the full navigation goes to. Vite answers it with the app's own index page. */
const CLAIM_PAIRS_ARRIVED = '/claim-pairs/arrived';
const ROW_HEIGHT = 30;
const LIST_HEIGHT = 180;
/** Rows rendered past the visible ones, as a virtualizer keeps a small overscan. */
const OVERSCAN = 2;

interface Row {
  id: number;
  label: string;
}

export function ClaimPairs(): React.ReactElement {
  const [rows, setRows] = useState<Row[]>([]);
  const [top, setTop] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(true);
  const [archived, setArchived] = useState('');

  useEffect(() => {
    void fetch(`${API}/rows`)
      .then((r) => r.json() as Promise<{ rows: Row[] }>)
      .then((body) => setRows(body.rows));
  }, []);

  const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((top + LIST_HEIGHT) / ROW_HEIGHT) + OVERSCAN);
  const visible = rows.slice(first, last);

  return (
    <div className="view">
      <div className="panel panel-pad" style={{ maxWidth: 560 }}>
        <h3>Route</h3>
        <button
          data-testid="claim-pairs-navigate"
          onClick={() => window.location.assign(CLAIM_PAIRS_ARRIVED)}
        >
          Open the arrival page
        </button>
        {/* The defect, on purpose: this button has no handler. */}
        <button data-testid="claim-pairs-inert">Open nothing</button>
      </div>
      <div className="panel panel-pad" style={{ maxWidth: 560 }}>
        <h3>Invoices</h3>
        <div
          data-testid="claim-pairs-list"
          style={{ height: LIST_HEIGHT, overflowY: 'auto', position: 'relative' }}
          onScroll={(e) => setTop(e.currentTarget.scrollTop)}
        >
          {/* One spacer sized for the whole list; only the rows in view are rendered inside it. */}
          <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
            {visible.map((row) => (
              <div
                key={row.id}
                role="row"
                style={{
                  position: 'absolute',
                  top: row.id * ROW_HEIGHT,
                  height: ROW_HEIGHT,
                  left: 0,
                  right: 0,
                }}
              >
                {row.label}
              </div>
            ))}
          </div>
        </div>
        <button
          data-testid="claim-pairs-archive"
          onClick={() =>
            void fetch(`${API}/archive`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: rows.length - 1 }),
            }).then(() => {
              setRows(rows.slice(0, -1));
              setArchived('Last invoice archived');
            })
          }
        >
          Archive the last invoice
        </button>
        <output data-testid="claim-pairs-archived">{archived}</output>
      </div>
      {dialogOpen ? (
        <div
          role="dialog"
          aria-label="Confirm delete"
          data-testid="claim-pairs-dialog"
          className="panel panel-pad"
          style={{ maxWidth: 560 }}
        >
          <p>Delete the draft?</p>
          <button data-testid="claim-pairs-dialog-close" onClick={() => setDialogOpen(false)}>
            Close
          </button>
        </div>
      ) : null}
    </div>
  );
}
